// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CharityRegistry.sol";

/**
 * @title DonationV3
 * @dev Frozen, non-upgradeable V2 donation contract for Give Protocol (Board-closed Option A).
 *
 * Design decisions encoded for external audit (GIV-1036 / GIV-1044):
 * - Non-upgradeable: No UUPS/transparent proxy, no Initializable, no storage gap.
 *   Governance (72h TimelockController) owns admin configuration (`Ownable`), while
 *   code is immutable once deployed.
 * - Separated Registry (MVP-SEC-05): Reads charity registration and active status
 *   from the standalone `CharityRegistry` contract (`charityRegistry` immutable or
 *   set-once reference). Deploying or redeploying `DonationV3` never requires
 *   re-registering charities.
 * - Per-Token Allowlist & Caps (MVP-SEC-02): Deny-by-default (`tokenConfigs[token].enabled == false`).
 *   Enforces per-transaction principal cap (`perTxCap > 0`) and rolling-24h cumulative
 *   principal cap (`dailyCap >= perTxCap`, `CAP_WINDOW = 24 hours`) on `charityAmount`
 *   before any transfer (Stage-1 reference: $500/tx, $2,500/24h).
 * - Platform Fee (MVP-DON-02): Hard-set to 50 bps (0.5%) at deployment with an on-chain
 *   post-init `assert(platformFeeRate == 50)` invariant check; bounded by `MAX_FEE_RATE = 500` (5%).
 * - Cause / Program Identifier (MVP-DON-04): `bytes32 causeId` threaded through donation
 *   entry points and emitted in `DonationProcessed` (`bytes32(0)` for general / unspecified cause).
 */
contract DonationV3 is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct TaxReceipt {
        address donor;
        address primaryBeneficiary;      // The charity
        uint256 charityAmount;
        uint256 giveProtocolAmount;      // Mandatory fee + optional platform tip
        uint256 totalTaxDeductible;      // Sum of both
        address tokenAddress;
        uint256 timestamp;
        string receiptType;              // "DUAL_BENEFICIARY" or "SINGLE_BENEFICIARY"
        bytes32 causeId;                 // Optional cause/program identifier (bytes32(0) if general)
    }

    struct TokenConfig {
        bool enabled;                    // Deny-by-default allowlist gate
        uint256 perTxCap;                // Token units, per-transaction (on charityAmount principal)
        uint256 dailyCap;                // Token units, rolling 24h (per token per chain)
        uint256 dailyWindowStart;        // Start timestamp of the current 24h bucket
        uint256 dailyVolume;             // Accumulated principal within the current window
    }

    // Constants
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MINIMUM_DONATION = 1e15; // 0.001 tokens minimum
    uint256 public constant DEFAULT_FEE_RATE = 50;   // 0.5% (50 bps) per MVP-DON-02
    uint256 public constant MAX_FEE_RATE = 500;      // Cap at 5%
    uint256 public constant CAP_WINDOW = 24 hours;

    // State variables
    address public giveProtocolTreasury;
    CharityRegistry public charityRegistry;
    mapping(address => mapping(address => uint256)) public donations; // donor => charity => amount
    mapping(bytes32 => TaxReceipt) public taxReceipts;

    // Pre-set tip percentages (in basis points: 500 = 5%, 1000 = 10%, 2000 = 20%)
    uint256[] public suggestedTipRates;

    // Mandatory platform fee (in basis points, initialized to 50 = 0.5%)
    uint256 public platformFeeRate;

    // Per-token caps / allowlist (deny-by-default). Native token uses address(0).
    mapping(address => TokenConfig) public tokenConfigs;

    // Donation accounting: total net amount received by each charity on this chain.
    mapping(address => uint256) public totalReceived;

    // Donation nonce to guarantee unique donationId even within the same block
    uint256 private _donationNonce;

    // Events
    event DonationProcessed(
        address indexed donor,
        address indexed charity,
        address token,
        uint256 charityAmount,
        uint256 platformTip,
        uint256 totalTaxDeductible,
        uint256 timestamp,
        bytes32 donationId,
        bytes32 indexed causeId
    );
    event TaxReceiptGenerated(bytes32 indexed receiptId, address indexed donor);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event PlatformFeeRateUpdated(uint256 oldRate, uint256 newRate);
    event TokenConfigUpdated(address indexed token, bool enabled, uint256 perTxCap, uint256 dailyCap);
    event CharityRegistryWired(address indexed charityRegistry);

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

    /**
     * @dev Deploy non-upgradeable DonationV3 contract.
     * @param _giveProtocolTreasury Address of Give Protocol treasury receiving fees and tips
     * @param initialOwner Address of the governance owner (e.g., 72h TimelockController)
     * @param _charityRegistry Address of the standalone CharityRegistry (may be address(0) and wired once via setCharityRegistry)
     * @param initialTokens Optional initial tokens to configure atomically on deploy
     * @param initialConfigs Matching TokenConfig array for `initialTokens`
     */
    constructor(
        address _giveProtocolTreasury,
        address initialOwner,
        address _charityRegistry,
        address[] memory initialTokens,
        TokenConfig[] memory initialConfigs
    ) Ownable(initialOwner) {
        require(_giveProtocolTreasury != address(0), "Invalid treasury address");
        if (initialTokens.length != initialConfigs.length) {
            revert InvalidAmount(initialTokens.length, "Token/config length mismatch");
        }

        giveProtocolTreasury = _giveProtocolTreasury;

        if (_charityRegistry != address(0)) {
            charityRegistry = CharityRegistry(_charityRegistry);
            emit CharityRegistryWired(_charityRegistry);
        }

        // MVP-DON-02: Hard-set platformFeeRate = 50 (0.5%) and assert post-init
        platformFeeRate = DEFAULT_FEE_RATE;
        assert(platformFeeRate == 50);

        suggestedTipRates.push(500);
        suggestedTipRates.push(1000);
        suggestedTipRates.push(2000);

        for (uint256 i = 0; i < initialTokens.length; i++) {
            _setTokenConfig(
                initialTokens[i],
                initialConfigs[i].enabled,
                initialConfigs[i].perTxCap,
                initialConfigs[i].dailyCap
            );
            TokenConfig storage cfg = tokenConfigs[initialTokens[i]];
            assert(cfg.enabled == initialConfigs[i].enabled);
            assert(cfg.perTxCap == initialConfigs[i].perTxCap);
            assert(cfg.dailyCap == initialConfigs[i].dailyCap);
        }
    }

    /**
     * @dev Wire the standalone CharityRegistry (set-once) if not passed at construction.
     * Charity registration / status is governed directly on the registry; this contract
     * only reads it for validation.
     */
    function setCharityRegistry(address _charityRegistry) external onlyOwner {
        require(_charityRegistry != address(0), "Invalid registry address");
        require(address(charityRegistry) == address(0), "Registry already set");
        charityRegistry = CharityRegistry(_charityRegistry);
        emit CharityRegistryWired(_charityRegistry);
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
     * @param newFeeRate New fee rate in basis points (50 = 0.5%, max 500 = 5%)
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
     * Setting enabled=false removes the token from the allowlist.
     */
    function setTokenConfig(
        address token,
        bool enabled,
        uint256 perTxCap,
        uint256 dailyCap
    ) external onlyOwner {
        _setTokenConfig(token, enabled, perTxCap, dailyCap);
    }

    /**
     * @dev Batch configure token allowlist + caps. onlyOwner (timelock).
     */
    function setTokenConfigs(
        address[] calldata tokens,
        TokenConfig[] calldata configs
    ) external onlyOwner {
        if (tokens.length != configs.length) {
            revert InvalidAmount(tokens.length, "Token/config length mismatch");
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            _setTokenConfig(tokens[i], configs[i].enabled, configs[i].perTxCap, configs[i].dailyCap);
            TokenConfig storage cfg = tokenConfigs[tokens[i]];
            assert(cfg.enabled == configs[i].enabled);
            assert(cfg.perTxCap == configs[i].perTxCap);
            assert(cfg.dailyCap == configs[i].dailyCap);
        }
    }

    function _setTokenConfig(
        address token,
        bool enabled,
        uint256 perTxCap,
        uint256 dailyCap
    ) internal {
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
     * @dev Process ERC20 donation with mandatory platform fee, optional tip, and cause identifier.
     * @param charity The verified charity receiving the donation
     * @param token The ERC20 token being donated
     * @param charityAmount Gross amount intended for charity (fee will be deducted)
     * @param platformTip Additional optional amount supporting Give Protocol (also tax-deductible)
     * @param causeId Identifier for the specific cause/program (bytes32(0) for general charity donation)
     */
    function processDonation(
        address charity,
        address token,
        uint256 charityAmount,
        uint256 platformTip,
        bytes32 causeId
    ) public nonReentrant whenNotPaused {
        _processDonation(charity, token, charityAmount, platformTip, causeId);
    }

    /**
     * @dev Backwards-compatible ERC20 donation entry point without causeId (defaults to bytes32(0)).
     */
    function processDonation(
        address charity,
        address token,
        uint256 charityAmount,
        uint256 platformTip
    ) external nonReentrant whenNotPaused {
        _processDonation(charity, token, charityAmount, platformTip, bytes32(0));
    }

    function _processDonation(
        address charity,
        address token,
        uint256 charityAmount,
        uint256 platformTip,
        bytes32 causeId
    ) internal {
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

        // Generate donation ID
        uint256 nonce = ++_donationNonce;
        bytes32 donationId = keccak256(
            abi.encode(msg.sender, charity, totalAmount, block.timestamp, causeId, nonce)
        );

        // Update tracking BEFORE external calls (checks-effects-interactions)
        totalReceived[charity] += netToCharity;
        donations[msg.sender][charity] += netToCharity;

        // Generate tax receipt
        _generateTaxReceipt(
            donationId,
            msg.sender,
            charity,
            netToCharity,
            totalToTreasury,
            token,
            causeId
        );

        // Transfer net amount to charity
        IERC20(token).safeTransferFrom(msg.sender, charity, netToCharity);

        // Transfer mandatory fee + optional tip to Give Protocol treasury
        if (totalToTreasury > 0) {
            IERC20(token).safeTransferFrom(msg.sender, giveProtocolTreasury, totalToTreasury);
        }

        // Emit event - ENTIRE amount is tax-deductible, including causeId
        emit DonationProcessed(
            msg.sender,
            charity,
            token,
            netToCharity,
            totalToTreasury,
            totalAmount,
            block.timestamp,
            donationId,
            causeId
        );
    }

    /**
     * @dev Process donation with percentage-based tip and causeId
     * @param charity The verified charity
     * @param token The token being donated
     * @param charityAmount Amount for charity
     * @param tipPercentage Tip as basis points (e.g., 500 = 5%)
     * @param causeId Identifier for the specific cause/program
     */
    function processDonationWithPercentageTip(
        address charity,
        address token,
        uint256 charityAmount,
        uint256 tipPercentage,
        bytes32 causeId
    ) external nonReentrant whenNotPaused {
        uint256 platformTip = (charityAmount * tipPercentage) / BASIS_POINTS;
        _processDonation(charity, token, charityAmount, platformTip, causeId);
    }

    /**
     * @dev Process donation with percentage-based tip (general donation, causeId = bytes32(0))
     */
    function processDonationWithPercentageTip(
        address charity,
        address token,
        uint256 charityAmount,
        uint256 tipPercentage
    ) external nonReentrant whenNotPaused {
        uint256 platformTip = (charityAmount * tipPercentage) / BASIS_POINTS;
        _processDonation(charity, token, charityAmount, platformTip, bytes32(0));
    }

    /**
     * @dev Process donation with suggested tip option and causeId
     * @param charity The verified charity
     * @param token The token being donated
     * @param charityAmount Amount for charity
     * @param tipOption 0 = 5%, 1 = 10%, 2 = 20%
     * @param causeId Identifier for the specific cause/program
     */
    function processDonationWithSuggestedTip(
        address charity,
        address token,
        uint256 charityAmount,
        uint8 tipOption,
        bytes32 causeId
    ) external nonReentrant whenNotPaused {
        if (tipOption >= suggestedTipRates.length) {
            revert InvalidTipOption(tipOption);
        }
        uint256 platformTip = calculateSuggestedTip(charityAmount, tipOption);
        _processDonation(charity, token, charityAmount, platformTip, causeId);
    }

    /**
     * @dev Process donation with suggested tip option (general donation, causeId = bytes32(0))
     */
    function processDonationWithSuggestedTip(
        address charity,
        address token,
        uint256 charityAmount,
        uint8 tipOption
    ) external nonReentrant whenNotPaused {
        if (tipOption >= suggestedTipRates.length) {
            revert InvalidTipOption(tipOption);
        }
        uint256 platformTip = calculateSuggestedTip(charityAmount, tipOption);
        _processDonation(charity, token, charityAmount, platformTip, bytes32(0));
    }

    /**
     * @dev Process native token (ETH/DEV/GLMR) donation with mandatory fee, optional tip, and causeId
     * @param charity The verified charity
     * @param platformTip Additional optional amount supporting Give Protocol
     * @param causeId Identifier for the specific cause/program (bytes32(0) for general)
     */
    function donateNative(
        address charity,
        uint256 platformTip,
        bytes32 causeId
    ) public payable nonReentrant whenNotPaused {
        _donateNative(charity, platformTip, causeId);
    }

    /**
     * @dev Process native token donation (general donation, causeId = bytes32(0))
     */
    function donateNative(
        address charity,
        uint256 platformTip
    ) external payable nonReentrant whenNotPaused {
        _donateNative(charity, platformTip, bytes32(0));
    }

    function _donateNative(
        address charity,
        uint256 platformTip,
        bytes32 causeId
    ) internal {
        _requireActiveCharity(charity);

        if (platformTip > msg.value) {
            revert InvalidAmount(platformTip, "Tip exceeds msg.value");
        }

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
        uint256 nonce = ++_donationNonce;
        bytes32 donationId = keccak256(
            abi.encode(msg.sender, charity, msg.value, block.timestamp, causeId, nonce)
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
            address(0), // address(0) indicates native token
            causeId
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
            donationId,
            causeId
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
        address token,
        bytes32 causeId
    ) internal {
        taxReceipts[receiptId] = TaxReceipt({
            donor: donor,
            primaryBeneficiary: charity,
            charityAmount: charityAmount,
            giveProtocolAmount: platformTip,
            totalTaxDeductible: charityAmount + platformTip,
            tokenAddress: token,
            timestamp: block.timestamp,
            receiptType: platformTip > 0 ? "DUAL_BENEFICIARY" : "SINGLE_BENEFICIARY",
            causeId: causeId
        });

        emit TaxReceiptGenerated(receiptId, donor);
    }

    /**
     * @dev Get charity information (delegated to standalone CharityRegistry + local totalReceived)
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
     * @dev Require that a charity is registered and active (read from the standalone registry).
     */
    function _requireActiveCharity(address charity) internal view {
        require(address(charityRegistry) != address(0), "Registry not set");
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
        string memory receiptType,
        bytes32 causeId
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
            receipt.receiptType,
            receipt.causeId
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
}
