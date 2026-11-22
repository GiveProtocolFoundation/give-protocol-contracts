// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/*
 * TEST-ONLY reconstruction of the live V1 DurationDonation (commit f29acba, the
 * last contract change before the Stage-1 caps and CharityRegistry extraction).
 * Present solely so test/StorageMigration.test.js can prove the V1 -> V2 storage
 * layout migration is safe. NOT for deployment.
 */
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title DurationDonation
 * @dev Enhanced donation contract with integrated platform tip functionality
 * All donations (including platform tips) are tax-deductible
 *
 * Storage Layout (contract state variables, sequential from slot 0):
 * | Slot  | Variable               | Type                                          |
 * |-------|------------------------|-----------------------------------------------|
 * | 0     | giveProtocolTreasury   | address                                       |
 * | 1     | charities              | mapping(address => Charity)                    |
 * | 2     | donations              | mapping(address => mapping(address => uint256))|
 * | 3     | taxReceipts            | mapping(bytes32 => TaxReceipt)                 |
 * | 4     | suggestedTipRates      | uint256[] (dynamic array)                      |
 * | 5     | platformFeeRate        | uint256                                        |
 * | 6-55  | __gap                  | uint256[50]                                    |
 *
 * Constants (bytecode, no storage slot):
 * - BASIS_POINTS = 10000
 * - MINIMUM_DONATION = 1e15
 * - MAX_FEE_RATE = 500
 */
contract DurationDonationV1 is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    struct Charity {
        bool isRegistered;
        address walletAddress;
        uint256 totalReceived;
        bool isActive;
    }

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

    // State variables
    address public giveProtocolTreasury;
    mapping(address => Charity) public charities;
    mapping(address => mapping(address => uint256)) public donations; // donor => charity => amount
    mapping(bytes32 => TaxReceipt) public taxReceipts;

    // Pre-set tip percentages (in basis points) — initialized in initialize()
    uint256[] public suggestedTipRates;
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MINIMUM_DONATION = 1e15; // 0.001 tokens minimum

    // Mandatory platform fee (in basis points, 100 = 1%) — initialized in initialize()
    uint256 public platformFeeRate;
    uint256 public constant MAX_FEE_RATE = 500; // Cap at 5%

    // Storage gap for future upgrades
    uint256[50] private __gap;

    // Events
    event CharityRegistered(address indexed charity, uint256 timestamp);
    event CharityStatusUpdated(address indexed charity, bool isActive);
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

    // Errors
    error CharityNotRegistered(address charity);
    error CharityNotActive(address charity);
    error InvalidAmount(uint256 amount, string reason);
    error InvalidTipOption(uint8 tipOption);
    error TransferFailed(address token, address from, address to, uint256 amount);
    error InvalidFeeRate(uint256 rate);

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
     * @dev Register a new charity
     * @param charityAddress The address of the charity to register
     */
    function registerCharity(address charityAddress) external onlyOwner {
        require(charityAddress != address(0), "Invalid charity address");
        require(!charities[charityAddress].isRegistered, "Charity already registered");

        charities[charityAddress] = Charity({
            isRegistered: true,
            walletAddress: charityAddress,
            totalReceived: 0,
            isActive: true
        });

        emit CharityRegistered(charityAddress, block.timestamp);
    }

    /**
     * @dev Update charity active status
     * @param charityAddress The address of the charity
     * @param isActive New active status
     */
    function updateCharityStatus(address charityAddress, bool isActive) external onlyOwner {
        if (!charities[charityAddress].isRegistered) {
            revert CharityNotRegistered(charityAddress);
        }

        charities[charityAddress].isActive = isActive;
        emit CharityStatusUpdated(charityAddress, isActive);
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
        if (!charities[charity].isRegistered) {
            revert CharityNotRegistered(charity);
        }

        if (!charities[charity].isActive) {
            revert CharityNotActive(charity);
        }

        if (charityAmount < MINIMUM_DONATION) {
            revert InvalidAmount(charityAmount, "Donation amount too small");
        }

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
        charities[charity].totalReceived += netToCharity;
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
        if (!charities[charity].isRegistered) {
            revert CharityNotRegistered(charity);
        }

        if (!charities[charity].isActive) {
            revert CharityNotActive(charity);
        }

        // Gross charity amount is msg.value minus optional tip
        uint256 charityAmount = msg.value - platformTip;

        if (charityAmount < MINIMUM_DONATION) {
            revert InvalidAmount(charityAmount, "Donation amount too small");
        }

        // Calculate mandatory platform fee
        uint256 mandatoryFee = (charityAmount * platformFeeRate) / BASIS_POINTS;
        uint256 netToCharity = charityAmount - mandatoryFee;
        uint256 totalToTreasury = mandatoryFee + platformTip;

        // Generate donation ID
        bytes32 donationId = keccak256(
            abi.encode(msg.sender, charity, msg.value, block.timestamp)
        );

        // Update tracking BEFORE external calls (checks-effects-interactions pattern)
        charities[charity].totalReceived += netToCharity;
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
        uint256 totalReceived,
        bool isActive
    ) {
        Charity storage charity = charities[charityAddress];
        return (
            charity.isRegistered,
            charity.walletAddress,
            charity.totalReceived,
            charity.isActive
        );
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
