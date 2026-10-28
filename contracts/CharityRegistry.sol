// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CharityRegistry
 * @dev Standalone, non-upgradeable registry of verified charity wallet addresses.
 *
 * Decoupled from the donation contract (MVP-SEC-05) so that any donation
 * contract — the current V1 (DurationDonation) and future non-upgradeable
 * versions — can point at the same registry. Deploying a new donation contract
 * never requires re-registering charities; the registry persists independently.
 *
 * Registration / status changes are gated by `onlyOwner`. Deploy this contract
 * with the protocol's governance (e.g. the GiveTimelockController) as owner so
 * registration remains under the same 72h-timelock governance as the donation
 * contract, and so multiple donation contracts can share it.
 */
contract CharityRegistry is Ownable {
    struct Charity {
        bool isRegistered;
        address walletAddress;   // Payout wallet; currently equal to the identity key.
        bool isActive;
    }

    /// @dev The canonical set of registered charities on this chain.
    mapping(address => Charity) public charities;

    event CharityRegistered(address indexed charity, uint256 timestamp);
    event CharityStatusUpdated(address indexed charity, bool isActive);

    error CharityNotRegistered(address charity);
    error CharityNotActive(address charity);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /**
     * @dev Register a single charity.
     */
    function registerCharity(address charityAddress) external onlyOwner {
        require(charityAddress != address(0), "Invalid charity address");
        require(!charities[charityAddress].isRegistered, "Charity already registered");

        charities[charityAddress] = Charity({
            isRegistered: true,
            walletAddress: charityAddress,
            isActive: true
        });

        emit CharityRegistered(charityAddress, block.timestamp);
    }

    /**
     * @dev Batch-register charities. Used for the one-time migration of the
     * charity set out of the donation contract into this registry.
     * Idempotent on already-registered (and zero) addresses.
     */
    function registerCharities(address[] calldata charityAddresses) external onlyOwner {
        for (uint256 i = 0; i < charityAddresses.length; i++) {
            _registerIfAbsent(charityAddresses[i]);
        }
    }

    function _registerIfAbsent(address charityAddress) internal {
        if (charityAddress == address(0) || charities[charityAddress].isRegistered) {
            return;
        }
        charities[charityAddress] = Charity({
            isRegistered: true,
            walletAddress: charityAddress,
            isActive: true
        });
        emit CharityRegistered(charityAddress, block.timestamp);
    }

    /**
     * @dev Update a charity's active status.
     */
    function updateCharityStatus(address charityAddress, bool newStatus) external onlyOwner {
        if (!charities[charityAddress].isRegistered) {
            revert CharityNotRegistered(charityAddress);
        }
        charities[charityAddress].isActive = newStatus;
        emit CharityStatusUpdated(charityAddress, newStatus);
    }

    /**
     * @dev Whether a charity is registered.
     */
    function isRegistered(address charityAddress) external view returns (bool) {
        return charities[charityAddress].isRegistered;
    }

    /**
     * @dev Whether a charity is registered and active.
     */
    function isActive(address charityAddress) external view returns (bool) {
        return charities[charityAddress].isActive;
    }

    /**
     * @dev Charity registration info.
     */
    function getCharityInfo(address charityAddress) external view returns (
        bool isRegistered_,
        address walletAddress,
        bool isActive_
    ) {
        Charity storage charity = charities[charityAddress];
        return (charity.isRegistered, charity.walletAddress, charity.isActive);
    }
}