// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title PortfolioFunds
 * @dev Portfolio fund management for Give Protocol - allows donors to contribute to curated charity groups
 *
 * Storage Layout (contract state variables, sequential from slot 0):
 * | Slot  | Variable            | Type                                      |
 * |-------|---------------------|-------------------------------------------|
 * | 0     | portfolioFunds      | mapping(bytes32 => PortfolioFund)          |
 * | 1     | activeFundIds       | bytes32[]                                  |
 * | 2     | verifiedCharities   | mapping(address => bool)                   |
 * | 3     | charityNames        | mapping(address => string)                 |
 * | 4     | charityToFunds      | mapping(address => bytes32[])              |
 * | 5     | treasury            | address                                    |
 * | 6     | platformFeeRate     | uint256                                    |
 * | 7     | governanceActive    | bool                                       |
 * | 8-57  | __gap               | uint256[50]                                |
 */
contract PortfolioFunds is Initializable, ReentrancyGuardUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // Fund structure
    struct PortfolioFund {
        string name;
        string description;
        bool active;
        uint256 createdAt;
        address[] charities;
        uint256[] distributionRatios; // Basis points (10000 = 100%) - Fixed at launch
        uint256 totalRaised;
        uint256 totalDistributed;
        mapping(address => uint256) tokenBalances; // token => total amount in fund
        mapping(address => mapping(address => uint256)) charityAllocations; // charity => token => claimable amount
        mapping(address => mapping(address => uint256)) charityClaimed; // charity => token => total claimed
    }

    // Fund registry
    mapping(bytes32 => PortfolioFund) public portfolioFunds;
    bytes32[] public activeFundIds;

    // Charity verification and management
    mapping(address => bool) public verifiedCharities;
    mapping(address => string) public charityNames;
    mapping(address => bytes32[]) public charityToFunds; // Which funds each charity participates in

    // Platform settings — initialized in initialize()
    address public treasury;
    uint256 public platformFeeRate;
    bool public governanceActive;

    // Storage gap for future upgrades
    uint256[50] private __gap;

    // Events
    event FundCreated(bytes32 indexed fundId, string name, address[] charities, uint256[] ratios);
    event DonationReceived(
        bytes32 indexed fundId,
        address indexed donor,
        address token,
        uint256 totalAmount,
        uint256 platformFee,
        uint256 netAmount
    );
    event FundsAllocated(bytes32 indexed fundId, address token, uint256 totalAmount);
    event CharityClaimedFunds(
        bytes32 indexed fundId,
        address indexed charity,
        address token,
        uint256 amount,
        uint256 totalClaimed
    );
    event DistributionRatiosUpdated(bytes32 indexed fundId, uint256[] newRatios);
    event GovernanceActivated(uint256 timestamp);
    event CharityVerified(address indexed charity, string name);
    event CharityUnverified(address indexed charity);
    event PlatformFeeUpdated(uint256 newRate);
    event TreasuryUpdated(address newTreasury);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _treasury, address admin) public initializer {
        require(_treasury != address(0), "Invalid treasury address");
        require(admin != address(0), "Invalid admin address");
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        treasury = _treasury;
        platformFeeRate = 50;
        assert(platformFeeRate == 50); // Post-deploy assertion: intended 0.5% (50 bps)
    }

    /**
     * @dev Create a new portfolio fund with equal distribution ratios (fixed at launch)
     */
    function createPortfolioFund(
        string memory fundName,
        string memory description,
        address[] memory charities,
        string[] memory _charityNames
    ) external onlyRole(ADMIN_ROLE) {
        require(charities.length > 0 && charities.length <= 10, "Invalid charity count");
        require(charities.length == _charityNames.length, "Array length mismatch");

        bytes32 fundId = keccak256(abi.encodePacked(fundName, block.timestamp));
        require(portfolioFunds[fundId].createdAt == 0, "Fund ID already exists");

        // Verify all charities
        for (uint i = 0; i < charities.length; i++) {
            require(verifiedCharities[charities[i]], "Charity not verified");
            require(charities[i] != address(0), "Invalid charity address");

            // Check for duplicates
            for (uint j = i + 1; j < charities.length; j++) {
                require(charities[i] != charities[j], "Duplicate charity");
            }
        }

        // Create equal distribution ratios (fixed at launch)
        uint256[] memory equalRatios = new uint256[](charities.length);
        uint256 equalShare = 10000 / charities.length;
        uint256 remainder = 10000 % charities.length;

        for (uint i = 0; i < charities.length; i++) {
            equalRatios[i] = equalShare;
            if (i < remainder) equalRatios[i] += 1; // Distribute remainder to first charities
        }

        // Initialize fund
        PortfolioFund storage fund = portfolioFunds[fundId];
        fund.name = fundName;
        fund.description = description;
        fund.active = true;
        fund.createdAt = block.timestamp;
        fund.charities = charities;
        fund.distributionRatios = equalRatios;

        // Store charity names and fund associations
        for (uint i = 0; i < charities.length; i++) {
            charityNames[charities[i]] = _charityNames[i];
            charityToFunds[charities[i]].push(fundId);
        }

        activeFundIds.push(fundId);

        emit FundCreated(fundId, fundName, charities, equalRatios);
    }

    /**
     * @dev Donate to a specific portfolio fund
     */
    function donateToFund(
        bytes32 fundId,
        address token,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        PortfolioFund storage fund = portfolioFunds[fundId];
        require(fund.active, "Fund not active");
        require(amount > 0, "Amount must be greater than 0");
        require(token != address(0), "Invalid token address");

        // Transfer tokens to contract
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Calculate platform fee (0.5%)
        uint256 platformFee = (amount * platformFeeRate) / 10000;
        uint256 netAmount = amount - platformFee;

        // Transfer platform fee to treasury
        if (platformFee > 0) {
            IERC20(token).safeTransfer(treasury, platformFee);
        }

        // Update fund balances
        fund.tokenBalances[token] += netAmount;
        fund.totalRaised += netAmount; // Note: This tracks token amount, not USD value

        // Allocate to charities based on fixed distribution ratios
        _allocateToCharities(fundId, token, netAmount);

        emit DonationReceived(fundId, msg.sender, token, amount, platformFee, netAmount);
        emit FundsAllocated(fundId, token, netAmount);
    }

    /**
     * @dev Donate native currency (DEV) to a portfolio fund
     */
    function donateNativeToFund(bytes32 fundId) external payable nonReentrant whenNotPaused {
        require(msg.value > 0, "Amount must be greater than 0");
        PortfolioFund storage fund = portfolioFunds[fundId];
        require(fund.active, "Fund not active");

        // Calculate platform fee (0.5%)
        uint256 platformFee = (msg.value * platformFeeRate) / 10000;
        uint256 netAmount = msg.value - platformFee;

        // Update fund balances BEFORE external calls (checks-effects-interactions pattern)
        fund.tokenBalances[address(0)] += netAmount;
        fund.totalRaised += netAmount;

        // Allocate to charities (state update)
        _allocateToCharities(fundId, address(0), netAmount);

        // Transfer platform fee to treasury (external call AFTER state updates)
        if (platformFee > 0) {
            (bool success, ) = treasury.call{value: platformFee}("");
            require(success, "Treasury transfer failed");
        }

        emit DonationReceived(fundId, msg.sender, address(0), msg.value, platformFee, netAmount);
        emit FundsAllocated(fundId, address(0), netAmount);
    }

    /**
     * @dev Internal function to allocate funds to charities based on fixed ratios
     */
    function _allocateToCharities(bytes32 fundId, address token, uint256 amount) internal {
        PortfolioFund storage fund = portfolioFunds[fundId];

        uint256 totalAllocated = 0;

        // Allocate to each charity except the last one
        for (uint i = 0; i < fund.charities.length - 1; i++) {
            uint256 charityShare = (amount * fund.distributionRatios[i]) / 10000;
            fund.charityAllocations[fund.charities[i]][token] += charityShare;
            totalAllocated += charityShare;
        }

        // Give remainder to last charity to handle rounding
        uint256 remainingAmount = amount - totalAllocated;
        fund.charityAllocations[fund.charities[fund.charities.length - 1]][token] += remainingAmount;
    }

    /**
     * @dev Allow charities to claim their allocated funds
     */
    function claimFunds(
        bytes32 fundId,
        address token
    ) external nonReentrant {
        PortfolioFund storage fund = portfolioFunds[fundId];
        require(fund.active, "Fund not active");

        // Verify caller is a charity in this fund
        bool isCharityInFund = false;
        for (uint i = 0; i < fund.charities.length; i++) {
            if (fund.charities[i] == msg.sender) {
                isCharityInFund = true;
                break;
            }
        }
        require(isCharityInFund, "Not authorized charity for this fund");

        uint256 claimableAmount = fund.charityAllocations[msg.sender][token];
        require(claimableAmount > 0, "No funds to claim");

        // Update allocations and tracking
        fund.charityAllocations[msg.sender][token] = 0;
        fund.charityClaimed[msg.sender][token] += claimableAmount;
        fund.totalDistributed += claimableAmount;

        // Transfer funds to charity
        if (token == address(0)) {
            // Native currency transfer
            (bool success, ) = msg.sender.call{value: claimableAmount}("");
            require(success, "Native transfer failed");
        } else {
            // ERC20 token transfer
            IERC20(token).safeTransfer(msg.sender, claimableAmount);
        }

        emit CharityClaimedFunds(
            fundId,
            msg.sender,
            token,
            claimableAmount,
            fund.charityClaimed[msg.sender][token]
        );
    }

    /**
     * @dev Batch claim multiple tokens for a charity
     */
    function claimMultipleTokens(
        bytes32 fundId,
        address[] memory tokens
    ) external nonReentrant {
        require(tokens.length > 0 && tokens.length <= 10, "Invalid token count");

        // First pass: collect amounts and update ALL state (checks-effects-interactions pattern)
        uint256[] memory amounts = new uint256[](tokens.length);
        for (uint i = 0; i < tokens.length; i++) {
            uint256 claimableAmount = portfolioFunds[fundId].charityAllocations[msg.sender][tokens[i]];
            if (claimableAmount > 0) {
                amounts[i] = claimableAmount;
                // Update all state before any external calls
                portfolioFunds[fundId].charityAllocations[msg.sender][tokens[i]] = 0;
                portfolioFunds[fundId].charityClaimed[msg.sender][tokens[i]] += claimableAmount;
                portfolioFunds[fundId].totalDistributed += claimableAmount;
            }
        }

        // Second pass: make all external transfers AFTER state updates
        for (uint i = 0; i < tokens.length; i++) {
            if (amounts[i] > 0) {
                if (tokens[i] == address(0)) {
                    (bool success, ) = msg.sender.call{value: amounts[i]}("");
                    require(success, "Native transfer failed");
                } else {
                    IERC20(tokens[i]).safeTransfer(msg.sender, amounts[i]);
                }

                emit CharityClaimedFunds(
                    fundId,
                    msg.sender,
                    tokens[i],
                    amounts[i],
                    portfolioFunds[fundId].charityClaimed[msg.sender][tokens[i]]
                );
            }
        }
    }

    /**
     * @dev Update distribution ratios via governance (only after governance is activated)
     */
    function updateDistributionRatios(
        bytes32 fundId,
        uint256[] memory newRatios
    ) external onlyRole(GOVERNANCE_ROLE) {
        require(governanceActive, "Governance not yet activated");

        PortfolioFund storage fund = portfolioFunds[fundId];
        require(fund.active, "Fund not active");
        require(newRatios.length == fund.charities.length, "Invalid ratios length");

        // Verify ratios sum to 10000 (100%)
        uint256 totalRatio = 0;
        for (uint i = 0; i < newRatios.length; i++) {
            require(newRatios[i] > 0, "Ratio cannot be zero");
            totalRatio += newRatios[i];
        }
        require(totalRatio == 10000, "Ratios must sum to 100%");

        fund.distributionRatios = newRatios;

        emit DistributionRatiosUpdated(fundId, newRatios);
    }

    /**
     * @dev View functions for charities and donors
     */
    function getFundDetails(bytes32 fundId) external view returns (
        string memory name,
        string memory description,
        bool active,
        address[] memory charities,
        uint256[] memory ratios,
        uint256 totalRaised,
        uint256 totalDistributed
    ) {
        PortfolioFund storage fund = portfolioFunds[fundId];
        return (
            fund.name,
            fund.description,
            fund.active,
            fund.charities,
            fund.distributionRatios,
            fund.totalRaised,
            fund.totalDistributed
        );
    }

    function getCharityClaimableAmount(
        bytes32 fundId,
        address charity,
        address token
    ) external view returns (uint256) {
        return portfolioFunds[fundId].charityAllocations[charity][token];
    }

    function getCharityTotalClaimed(
        bytes32 fundId,
        address charity,
        address token
    ) external view returns (uint256) {
        return portfolioFunds[fundId].charityClaimed[charity][token];
    }

    function getCharityFunds(address charity) external view returns (bytes32[] memory) {
        return charityToFunds[charity];
    }

    function getFundBalance(bytes32 fundId, address token) external view returns (uint256) {
        return portfolioFunds[fundId].tokenBalances[token];
    }

    function getAllActiveFunds() external view returns (bytes32[] memory) {
        return activeFundIds;
    }

    /**
     * @dev Admin functions
     */
    function addVerifiedCharity(
        address charity,
        string memory name
    ) external onlyRole(ADMIN_ROLE) {
        require(charity != address(0), "Invalid charity address");
        require(bytes(name).length > 0, "Name cannot be empty");
        verifiedCharities[charity] = true;
        charityNames[charity] = name;
        emit CharityVerified(charity, name);
    }

    function removeVerifiedCharity(address charity) external onlyRole(ADMIN_ROLE) {
        verifiedCharities[charity] = false;
        emit CharityUnverified(charity);
    }

    function updatePlatformFeeRate(uint256 newRate) external onlyRole(ADMIN_ROLE) {
        require(newRate <= 500, "Fee cannot exceed 5%"); // Safety cap at 5%
        platformFeeRate = newRate;
        emit PlatformFeeUpdated(newRate);
    }

    function activateGovernance() external onlyRole(ADMIN_ROLE) {
        require(!governanceActive, "Governance already active");
        governanceActive = true;
        emit GovernanceActivated(block.timestamp);
    }

    function pauseFund(bytes32 fundId) external onlyRole(ADMIN_ROLE) {
        portfolioFunds[fundId].active = false;
    }

    function unpauseFund(bytes32 fundId) external onlyRole(ADMIN_ROLE) {
        portfolioFunds[fundId].active = true;
    }

    function updateTreasury(address newTreasury) external onlyRole(ADMIN_ROLE) {
        require(newTreasury != address(0), "Invalid treasury address");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function emergencyPause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function emergencyUnpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @dev Authorize contract upgrade — only DEFAULT_ADMIN_ROLE can upgrade
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
