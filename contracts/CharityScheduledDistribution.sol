// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title CharityScheduledDistribution
 * @dev Allows donors to schedule token distributions to charities on a monthly basis
 *
 * Storage Layout (contract state variables, sequential from slot 0):
 * | Slot  | Variable            | Type                                      |
 * |-------|---------------------|-------------------------------------------|
 * | 0     | donationSchedules   | mapping(uint256 => DonationSchedule)       |
 * | 1     | nextScheduleId      | uint256                                    |
 * | 2     | tokenPrices         | mapping(address => uint256)                |
 * | 3     | verifiedCharities   | mapping(address => bool)                   |
 * | 4     | treasury            | address                                    |
 * | 5     | platformFeeRate     | uint256                                    |
 * | 6-55  | __gap               | uint256[50]                                |
 *
 * Constants (bytecode, no storage slot):
 * - MAX_FEE_RATE = 500
 * - BASIS_POINTS = 10000
 * - DISTRIBUTION_INTERVAL = 30 days
 * - MIN_DONATION_USD = 10 * 10**8
 * - MAX_MONTHS = 60
 * - MIN_MONTHS = 1
 */
contract CharityScheduledDistribution is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // Struct to track donation schedules
    struct DonationSchedule {
        address donor;
        address charity;
        address token;
        uint256 totalAmount;
        uint256 amountPerMonth;
        uint256 monthsRemaining;
        uint256 nextDistributionTimestamp;
        bool active;
    }

    // Mapping of scheduleId to DonationSchedule
    mapping(uint256 => DonationSchedule) public donationSchedules;

    // Counter for schedule IDs
    uint256 public nextScheduleId;

    // Mapping for token prices (simplified version without Chainlink)
    mapping(address => uint256) public tokenPrices;

    // Verified charities
    mapping(address => bool) public verifiedCharities;

    // Platform fee settings — initialized in initialize()
    address public treasury;
    uint256 public platformFeeRate;
    uint256 public constant MAX_FEE_RATE = 500; // Cap at 5%
    uint256 public constant BASIS_POINTS = 10000;

    // Distribution interval (30 days in seconds)
    uint256 public constant DISTRIBUTION_INTERVAL = 30 days;

    // Minimum donation amount in USD (10 USD with 8 decimals)
    uint256 public constant MIN_DONATION_USD = 10 * 10**8;

    // Maximum number of months allowed
    uint256 public constant MAX_MONTHS = 60;

    // Minimum number of months allowed
    uint256 public constant MIN_MONTHS = 1;

    // Storage gap for future upgrades
    uint256[50] private __gap;

    // Events
    event CharityAdded(address indexed charity);
    event CharityRemoved(address indexed charity);
    event TokenPriceSet(address indexed token, uint256 price);
    event ScheduleCreated(
        uint256 indexed scheduleId,
        address indexed donor,
        address indexed charity,
        address token,
        uint256 totalAmount,
        uint256 amountPerMonth,
        uint256 months
    );
    event DistributionExecuted(
        uint256 indexed scheduleId,
        address indexed charity,
        address token,
        uint256 amount,
        uint256 monthsRemaining
    );
    event ScheduleCancelled(uint256 indexed scheduleId);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event PlatformFeeRateUpdated(uint256 oldRate, uint256 newRate);
    event PlatformFeeCollected(uint256 indexed scheduleId, address token, uint256 feeAmount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the contract
     * @param _treasury Address of the platform treasury for fee collection
     * @param initialOwner Address of the contract owner
     */
    function initialize(address _treasury, address initialOwner) public initializer {
        require(_treasury != address(0), "Invalid treasury address");
        require(initialOwner != address(0), "Invalid owner address");
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        treasury = _treasury;
        platformFeeRate = 50;
        assert(platformFeeRate == 50); // Post-deploy assertion: intended 0.5% (50 bps)
    }

    /**
     * @dev Add a verified charity
     * @param charity The charity address to add
     */
    function addCharity(address charity) external onlyOwner {
        require(charity != address(0), "Invalid charity address");
        verifiedCharities[charity] = true;
        emit CharityAdded(charity);
    }

    /**
     * @dev Remove a verified charity
     * @param charity The charity address to remove
     */
    function removeCharity(address charity) external onlyOwner {
        verifiedCharities[charity] = false;
        emit CharityRemoved(charity);
    }

    /**
     * @dev Set price for a token (simplified version without Chainlink)
     * @param token The token address
     * @param price The token price in USD (8 decimals)
     */
    function setTokenPrice(address token, uint256 price) external onlyOwner {
        require(token != address(0), "Invalid token address");
        require(price > 0, "Price must be > 0");
        tokenPrices[token] = price;
        emit TokenPriceSet(token, price);
    }

    /**
     * @dev Get token price in USD
     * @param token The token address
     * @return price The token price in USD (8 decimals)
     */
    function getTokenPrice(address token) public view returns (uint256) {
        uint256 price = tokenPrices[token];
        require(price > 0, "Price not set");
        return price;
    }

    /**
     * @dev Create a new monthly distribution schedule
     * @param charity The charity address
     * @param token The token address
     * @param totalAmount The total amount to distribute (in token's smallest unit)
     * @param numberOfMonths The number of months to distribute over (1-60)
     * @param tokenPriceUSD The current token price in USD (8 decimals, e.g., 1 USD = 100000000)
     */
    function createSchedule(
        address charity,
        address token,
        uint256 totalAmount,
        uint256 numberOfMonths,
        uint256 tokenPriceUSD
    ) external nonReentrant whenNotPaused {
        require(verifiedCharities[charity], "Charity not verified");
        require(totalAmount > 0, "Amount must be > 0");
        require(numberOfMonths >= MIN_MONTHS && numberOfMonths <= MAX_MONTHS, "Invalid number of months");
        require(tokenPriceUSD > 0, "Token price must be > 0");

        // Calculate total donation value in USD (with 8 decimals)
        uint256 totalValueUSD = (totalAmount * tokenPriceUSD) / 1e18;

        // Verify minimum donation amount ($10 USD)
        require(totalValueUSD >= MIN_DONATION_USD, "Donation below minimum ($10 USD)");

        // Calculate monthly distribution
        uint256 amountPerMonth = totalAmount / numberOfMonths;
        require(amountPerMonth > 0, "Monthly amount too small");

        // Transfer tokens from donor to this contract
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);

        // Create schedule
        uint256 scheduleId = nextScheduleId++;
        donationSchedules[scheduleId] = DonationSchedule({
            donor: msg.sender,
            charity: charity,
            token: token,
            totalAmount: totalAmount,
            amountPerMonth: amountPerMonth,
            monthsRemaining: numberOfMonths,
            nextDistributionTimestamp: block.timestamp + DISTRIBUTION_INTERVAL,
            active: true
        });

        emit ScheduleCreated(
            scheduleId,
            msg.sender,
            charity,
            token,
            totalAmount,
            amountPerMonth,
            numberOfMonths
        );
    }

    /**
     * @dev Execute distributions that are due
     * @param scheduleIds Array of schedule IDs to process
     */
    function executeDistributions(uint256[] calldata scheduleIds) external nonReentrant whenNotPaused {
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            uint256 scheduleId = scheduleIds[i];
            DonationSchedule storage schedule = donationSchedules[scheduleId];

            if (
                schedule.active &&
                schedule.monthsRemaining > 0 &&
                block.timestamp >= schedule.nextDistributionTimestamp
            ) {
                // Calculate platform fee from monthly amount
                uint256 platformFee = (schedule.amountPerMonth * platformFeeRate) / BASIS_POINTS;
                uint256 netToCharity = schedule.amountPerMonth - platformFee;

                // Transfer net amount to charity
                IERC20(schedule.token).safeTransfer(schedule.charity, netToCharity);

                // Transfer platform fee to treasury
                if (platformFee > 0) {
                    IERC20(schedule.token).safeTransfer(treasury, platformFee);
                    emit PlatformFeeCollected(scheduleId, schedule.token, platformFee);
                }

                // Update schedule
                schedule.monthsRemaining--;
                schedule.nextDistributionTimestamp += DISTRIBUTION_INTERVAL;

                // If all months distributed, mark schedule as inactive
                if (schedule.monthsRemaining == 0) {
                    schedule.active = false;
                }

                emit DistributionExecuted(
                    scheduleId,
                    schedule.charity,
                    schedule.token,
                    netToCharity,
                    schedule.monthsRemaining
                );
            }
        }
    }

    /**
     * @dev Cancel a schedule (only by donor)
     * @param scheduleId The schedule ID to cancel
     */
    function cancelSchedule(uint256 scheduleId) external nonReentrant whenNotPaused {
        DonationSchedule storage schedule = donationSchedules[scheduleId];

        require(schedule.donor == msg.sender, "Not the donor");
        require(schedule.active, "Schedule not active");

        // Calculate remaining amount
        uint256 remainingAmount = schedule.amountPerMonth * schedule.monthsRemaining;

        // Mark schedule as inactive BEFORE external call (check-effects-interactions pattern)
        schedule.active = false;
        schedule.monthsRemaining = 0;

        // Transfer remaining tokens back to donor
        IERC20(schedule.token).safeTransfer(schedule.donor, remainingAmount);

        emit ScheduleCancelled(scheduleId);
    }

    /**
     * @dev Get all active schedules for a donor
     * @param donor The donor address
     * @return scheduleIds Array of schedule IDs
     */
    function getDonorSchedules(address donor) external view returns (uint256[] memory) {
        uint256 count = 0;

        // Count schedules (start from 0, not 1)
        for (uint256 i = 0; i < nextScheduleId; i++) {
            if (donationSchedules[i].donor == donor && donationSchedules[i].active) {
                count++;
            }
        }

        // Populate result
        uint256[] memory result = new uint256[](count);
        uint256 index = 0;

        for (uint256 i = 0; i < nextScheduleId; i++) {
            if (donationSchedules[i].donor == donor && donationSchedules[i].active) {
                result[index] = i;
                index++;
            }
        }

        return result;
    }

    /**
     * @dev Update treasury address
     * @param newTreasury New treasury address
     */
    function updateTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury address");
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @dev Update platform fee rate
     * @param newFeeRate New fee rate in basis points (50 = 0.5%)
     */
    function updatePlatformFeeRate(uint256 newFeeRate) external onlyOwner {
        require(newFeeRate <= MAX_FEE_RATE, "Fee rate exceeds maximum");
        uint256 oldRate = platformFeeRate;
        platformFeeRate = newFeeRate;
        emit PlatformFeeRateUpdated(oldRate, newFeeRate);
    }

    /**
     * @dev Pause the contract
     * Only owner can call this function
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause the contract
     * Only owner can call this function
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Authorize contract upgrade — only owner can upgrade
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
