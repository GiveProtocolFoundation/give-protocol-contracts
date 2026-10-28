// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CharityRegistry.sol";

/**
 * @title DurationDonation
 * @dev Enhanced donation contract with integrated platform tip functionality
 * All donations (including platform tips) are tax-deductible
 *
 * Storage Layout (contract state variables, sequential from slot 0):
 * | Slot  | Variable               | Type                                          |
 * |-------|------------------------|-----------------------------------------------|
 * | 0     | giveProtocolTreasury   | address                                       |
 * | 1     | charityRegistry        | CharityRegistry                               |
 * | 2     | donations              | mapping(address => mapping(address => uint256))|
 * | 3     | taxReceipts            | mapping(bytes32 => TaxReceipt)                 |
 * | 4     | suggestedTipRates      | uint256[] (dynamic array)                      |
 * | 5     | platformFeeRate        | uint256                                        |
 * | 6     | tokenConfigs           | mapping(address => TokenConfig)                 |
 * | 7     | totalReceived          | mapping(address => uint256)                    |
 * | 8-55  | __gap                  | uint256[48]                                    |
 *
 * Constants (bytecode, no storage slot):
 * - BASIS_POINTS = 10000
 * - MINIMUM_DONATION = 1e15
 * - MAX_FEE_RATE = 500
 * - CAP_WINDOW = 24 hours
 */
contract DurationDonation is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    struct TaxReceipt {
        address donor;
        address primaryBeneficiary;      // The charity
        uint256 charityAmount;
        uint256 giveProtocolAmount;      // Platform tip
        uint256 totalTaxDeductible;      // Sum of both
        address tokenAddress;
        uint256 timestamp;
        string receiptType;              // "DUAL_BENEFICIARY" or "SINGLE_BENEFICIARY"
    }

    struct TokenConfig {
        bool enabled;                    // Deny-by-default allowlist gate
        uint256 perTxCap;                // Token units, per-transaction (on charityAmount principal)
        uint256 dailyCap;                // Token units, rolling 24h (per token per chain)
        uint256 dailyWindowStart;        // Start timestamp of the current 24h bucket
        uint256 dailyVolume;             // Accumulated principal within the current window
    }

    // State variables
    address public giveProtocolTreasury;
    CharityRegistry public charityRegistry;
    mapping(address => mapping(address => uint256)) public donations; // donor => charity => amount
    mapping(bytes32 => TaxReceipt) public taxReceipts;

    // Pre-set tip percentages (in basis points) — initialized in initialize()
    uint256[] public suggestedTipRates;
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MINIMUM_DONATION = 1e15; // 0.001 tokens minimum

    // Mandatory platform fee (in basis points, 100 = 1%) — initialized in initialize()
    uint256 public platformFeeRate;
    uint256 public constant MAX_FEE_RATE = 500; // Cap at 5%

    // Per-token caps / allowlist (deny-by-default). Native token uses address(0).
    mapping(address => TokenConfig) public tokenConfigs;
    uint256 public constant CAP_WINDOW = 24 hours;

    // Donation accounting: total net amount received by each charity on this chain.
    mapping(address => uint256) public totalReceived;

    // Storage gap for future upgrades
    uint256[48] private __gap;

    // Events
    event DonationProcessed(
        address indexed donor,
        address indexed charity,
        address token,
        uint256 charityAmount,
        uint256 platformTip,
        uint256 totalTaxDeductible,
        uint256 timestamp,
        bytes32 donationId
    );
    event TaxReceiptGenerated(bytes32 indexed receiptId, address indexed donor);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event PlatformFeeRateUpdated(uint256 oldRate, uint256 newRate);
    event TokenConfigUpdated(address indexed token, bool enabled, uint256 perTxCap, uint256 dailyCap);

    // Errors
    error CharityNotRegistered(address charity);
    error CharityNotActive(address charity);
    error InvalidAmount(uint256 amount, string reason);
    error InvalidTipOption(uint8 tipOption);
    error TransferFailed(address token, address from, address to, uint256 amount);
    error InvalidFeeRate(uint256 rate);
    error TokenNotAllowed(address token);
    error ExceedsPerTxCap(address token, uint256 amount, uint256 cap);
    error ExceedsDailyCap(address token, uint256 amount, uint256 dailyVolume, uint256 cap);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _giveProtocolTreasury, address initialOwner) public initializer {
        require(_giveProtocolTreasury != address(0), "Invalid treasury address");
        require(initialOwner != address(0), "Invalid owner address");
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        giveProtocolTreasury = _giveProtocolTreasury;
        platformFeeRate = 100;
        suggestedTipRates.push(500);
        suggestedTipRates.push(1000);
        suggestedTipRates.push(2000);
    }

    /**
     * @dev Atomic Stage-1 caps/allowlist initialization.
     * Called as part of `upgradeToAndCall(newImpl, initializeV2(tokens, configs))`
     * so the upgrade and initial config land in a single storage write.
     * Deny-by-default: any token not listed here (incl. address(0)) is disabled.
     */
    function initializeV2(
        address[] calldata tokens,
        TokenConfig[] calldata configs
    ) external onlyOwner reinitializer(2) {
        if (tokens.length != configs.length) {
            revert InvalidAmount(tokens.length, "Token/config length mismatch");
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            _setTokenConfig(tokens[i], configs[i].enabled, configs[i].perTxCap, configs[i].dailyCap);
        }
    }

    /**
     * @dev Wire the standalone CharityRegistry (set-once). Charity registration /
     * status is governed directly on the registry (owned by the protocol
     * timelock); this contract only reads it for validation.
     */
    function setCharityRegistry(address _charityRegistry) external onlyOwner {
        require(_charityRegistry != address(0), "Invalid registry address");
        require(address(charityRegistry) == address(0), "Registry already set");
        charityRegistry = CharityRegistry(_charityRegistry);
    }

    /**
     * @dev Update Give Protocol treasury address
     * @param newTreasury New treasury address
     */
    function updateTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury address");
        address oldTreasury = giveProtocolTreasury;
        giveProtocolTreasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @dev Update platform fee rate
     * @param newFeeRate New fee rate in basis points (100 = 1%)
     */
    function updatePlatformFeeRate(uint256 newFeeRate) external onlyOwner {
        if (newFeeRate > MAX_FEE_RATE) {
            revert InvalidFeeRate(newFeeRate);
        }
        uint256 oldRate = platformFeeRate;
        platformFeeRate = newFeeRate;
        emit PlatformFeeRateUpdated(oldRate, newFeeRate);
    }

    /**
     * @dev Configure (or disable) a token's allowlist + caps. onlyOwner (timelock).
     * Use address(0) as `token` for the native asset.
     * Setting enabled=false (or calling with no caps) removes the token from the allowlist.
     */
    function setTokenConfig(address token, bool enabled, uint256 perTxCap, uint256 dailyCap) external onlyOwner {
        _setTokenConfig(token, enabled, perTxCap, dailyCap);
    }

    function _setTokenConfig(address token, bool enabled, uint256 perTxCap, uint256 dailyCap) internal {
        if (enabled) {
            if (perTxCap == 0) {
                revert InvalidAmount(perTxCap, "Per-tx cap must be > 0");
            }
            if (dailyCap < perTxCap) {
                revert InvalidAmount(dailyCap, "Daily cap must be >= per-tx cap");
            }
        }
        tokenConfigs[token] = TokenConfig({
            enabled: enabled,
            perTxCap: perTxCap,
            dailyCap: dailyCap,
            dailyWindowStart: 0,
            dailyVolume: 0
        });
        emit TokenConfigUpdated(token, enabled, perTxCap, dailyCap);
    }

    /**
     * @dev Enforce allowlist + per-tx + rolling-24h caps on the principal amount.
     * Must run before any transfer (checks-effects-interactions).
     */
    function _checkTokenCaps(address token, uint256 amount) internal {
        TokenConfig storage cfg = tokenConfigs[token];
        if (!cfg.enabled) {
            revert TokenNotAllowed(token);
        }
        if (amount > cfg.perTxCap) {
            revert ExceedsPerTxCap(token, amount, cfg.perTxCap);
        }
        if (block.timestamp >= cfg.dailyWindowStart + CAP_WINDOW) {
            cfg.dailyWindowStart = block.timestamp;
            cfg.dailyVolume = 0;
        }
        uint256 newDailyVolume = cfg.dailyVolume + amount;
        if (newDailyVolume > cfg.dailyCap) {
            revert ExceedsDailyCap(token, amount, cfg.dailyVolume, cfg.dailyCap);
        }
        cfg.dailyVolume = newDailyVolume;
    }

    /**
     * @dev Process donation with mandatory platform fee and optional tip
     * @param charity The verified charity receiving the donation
     * @param token The ERC20 token being donated
     * @param charityAmount Gross amount intended for charity (fee will be deducted)
     * @param platformTip Additional optional amount supporting Give Protocol (also tax-deductible)
     */
    function processDonation(
        address charity,
        address token,
        uint256 charityAmount,
        uint256 platformTip
    ) public nonReentrant whenNotPaused {
        _requireActiveCharity(charity);

        if (charityAmount < MINIMUM_DONATION) {
            revert InvalidAmount(charityAmount, "Donation amount too small");
        }

        _checkTokenCaps(token, charityAmount);

        // Calculate mandatory platform fee
        uint256 mandatoryFee = (charityAmount * platformFeeRate) / BASIS_POINTS;
        uint256 netToCharity = charityAmount - mandatoryFee;
        uint256 totalToTreasury = mandatoryFee + platformTip;
        uint256 totalAmount = charityAmount + platformTip;

        // Transfer net amount to charity
        IERC20(token).safeTransferFrom(msg.sender, charity, netToCharity);

        // Transfer mandatory fee + optional tip to Give Protocol treasury
        if (totalToTreasury > 0) {
            IERC20(token).safeTransferFrom(msg.sender, giveProtocolTreasury, totalToTreasury);
        }

        // Update tracking (track net amount received by charity)
        totalReceived[charity] += netToCharity;
        donations[msg.sender][charity] += netToCharity;

        // Generate donation ID
        bytes32 donationId = keccak256(
            abi.encode(msg.sender, charity, totalAmount, block.timestamp)
        );

        // Generate tax receipt (gross charity amount is tax-deductible as it's going to registered charity)
        _generateTaxReceipt(
            donationId,
            msg.sender,
            charity,
            netToCharity,
            totalToTreasury,
            token
        );

        // Emit event - ENTIRE amount is tax-deductible
        emit DonationProcessed(
            msg.sender,
            charity,
            token,
            netToCharity,
            totalToTreasury,
            totalAmount,
            block.timestamp,
            donationId
        );
    }

    /**
     * @dev Process donation with percentage-based tip
     * @param charity The verified charity
     * @param token The token being donated
     * @param charityAmount Amount for charity
     * @param tipPercentage Tip as basis points (e.g., 500 = 5%)
     */
    function processDonationWithPercentageTip(
        address charity,
        address token,
        uint256 charityAmount,
        uint256 tipPercentage
    ) external {
        uint256 platformTip = (charityAmount * tipPercentage) / BASIS_POINTS;
        processDonation(charity, token, charityAmount, platformTip);
    }

    /**
     * @dev Process donation with suggested tip option
     * @param charity The verified charity
     * @param token The token being donated
     * @param charityAmount Amount for charity
     * @param tipOption 0 = 5%, 1 = 10%, 2 = 20%
     */
    function processDonationWithSuggestedTip(
        address charity,
        address token,
        uint256 charityAmount,
        uint8 tipOption
    ) external {
        if (tipOption >= suggestedTipRates.length) {
            revert InvalidTipOption(tipOption);
        }
        uint256 platformTip = calculateSuggestedTip(charityAmount, tipOption);
        processDonation(charity, token, charityAmount, platformTip);
    }

    /**
     * @dev Process native token (DEV/GLMR) donation with mandatory fee
     * @param charity The verified charity
     * @param platformTip Additional optional amount supporting Give Protocol
     */
    function donateNative(
        address charity,
        uint256 platformTip
    ) external payable nonReentrant whenNotPaused {
        _requireActiveCharity(charity);

        // Gross charity amount is msg.value minus optional tip
        uint256 charityAmount = msg.value - platformTip;

        if (charityAmount < MINIMUM_DONATION) {
            revert InvalidAmount(charityAmount, "Donation amount too small");
        }

        _checkTokenCaps(address(0), charityAmount);

        // Calculate mandatory platform fee
        uint256 mandatoryFee = (charityAmount * platformFeeRate) / BASIS_POINTS;
        uint256 netToCharity = charityAmount - mandatoryFee;
        uint256 totalToTreasury = mandatoryFee + platformTip;

        // Generate donation ID
        bytes32 donationId = keccak256(
            abi.encode(msg.sender, charity, msg.value, block.timestamp)
        );

        // Update tracking BEFORE external calls (checks-effects-interactions pattern)
        totalReceived[charity] += netToCharity;
        donations[msg.sender][charity] += netToCharity;

        // Generate receipt (state update)
        _generateTaxReceipt(
            donationId,
            msg.sender,
            charity,
            netToCharity,
            totalToTreasury,
            address(0) // address(0) indicates native token
        );

        // Transfer net amount to charity (external call AFTER state updates)
        (bool charitySuccess, ) = charity.call{value: netToCharity}("");
        require(charitySuccess, "Transfer to charity failed");

        // Transfer mandatory fee + optional tip to Give Protocol treasury
        if (totalToTreasury > 0) {
            (bool treasurySuccess, ) = giveProtocolTreasury.call{value: totalToTreasury}("");
            require(treasurySuccess, "Transfer to treasury failed");
        }

        // Emit event
        emit DonationProcessed(
            msg.sender,
            charity,
            address(0), // native token
            netToCharity,
            totalToTreasury,
            msg.value,
            block.timestamp,
            donationId
        );
    }

    /**
     * @dev Convenience function to calculate suggested tip amounts
     * @param donationAmount The base donation amount
     * @param tipOption 0 = 5%, 1 = 10%, 2 = 20%
     */
    function calculateSuggestedTip(
        uint256 donationAmount,
        uint8 tipOption
    ) public view returns (uint256) {
        if (tipOption >= suggestedTipRates.length) {
            revert InvalidTipOption(tipOption);
        }
        return (donationAmount * suggestedTipRates[tipOption]) / BASIS_POINTS;
    }

    /**
     * @dev Generate comprehensive tax receipt
     */
    function _generateTaxReceipt(
        bytes32 receiptId,
        address donor,
        address charity,
        uint256 charityAmount,
        uint256 platformTip,
        address token
    ) internal {
        taxReceipts[receiptId] = TaxReceipt({
            donor: donor,
            primaryBeneficiary: charity,
            charityAmount: charityAmount,
            giveProtocolAmount: platformTip,
            totalTaxDeductible: charityAmount + platformTip,
            tokenAddress: token,
            timestamp: block.timestamp,
            receiptType: platformTip > 0 ? "DUAL_BENEFICIARY" : "SINGLE_BENEFICIARY"
        });

        emit TaxReceiptGenerated(receiptId, donor);
    }

    /**
     * @dev Get charity information
     * @param charityAddress The address of the charity
     */
    function getCharityInfo(address charityAddress) external view returns (
        bool isRegistered,
        address walletAddress,
        uint256 totalReceivedAmount,
        bool isActive
    ) {
        return (
            charityRegistry.isRegistered(charityAddress),
            charityAddress,
            totalReceived[charityAddress],
            charityRegistry.isActive(charityAddress)
        );
    }

    /**
     * @dev Require that a charity is registered and active (read from the registry).
     */
    function _requireActiveCharity(address charity) internal view {
        if (!charityRegistry.isRegistered(charity)) {
            revert CharityNotRegistered(charity);
        }
        if (!charityRegistry.isActive(charity)) {
            revert CharityNotActive(charity);
        }
    }

    /**
     * @dev Get donation amount from donor to charity
     * @param donor The donor address
     * @param charity The charity address
     */
    function getDonationAmount(
        address donor,
        address charity
    ) external view returns (uint256) {
        return donations[donor][charity];
    }

    /**
     * @dev Get all suggested tip rates
     */
    function getSuggestedTipRates() external view returns (uint256[] memory) {
        return suggestedTipRates;
    }

    /**
     * @dev Get tax receipt details
     * @param receiptId The receipt ID
     */
    function getTaxReceipt(bytes32 receiptId) external view returns (
        address donor,
        address primaryBeneficiary,
        uint256 charityAmount,
        uint256 giveProtocolAmount,
        uint256 totalTaxDeductible,
        address tokenAddress,
        uint256 timestamp,
        string memory receiptType
    ) {
        TaxReceipt storage receipt = taxReceipts[receiptId];
        return (
            receipt.donor,
            receipt.primaryBeneficiary,
            receipt.charityAmount,
            receipt.giveProtocolAmount,
            receipt.totalTaxDeductible,
            receipt.tokenAddress,
            receipt.timestamp,
            receipt.receiptType
        );
    }

    /**
     * @dev Pause the contract
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Authorize contract upgrade — only owner can upgrade
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
