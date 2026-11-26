# Storage Layouts — Give Protocol UUPS Contracts

All OZ v5 upgradeable base contracts use ERC-7201 namespaced storage (not sequential slots).
The contract's own state variables start at sequential slots after the inherited storage.

---

## DurationDonation

### Inherited (OZ Upgradeable — ERC-7201 namespaced)
- `OwnableUpgradeable`: namespaced at `keccak256("openzeppelin.storage.Ownable")`
- `ReentrancyGuardUpgradeable`: namespaced at `keccak256("openzeppelin.storage.ReentrancyGuard")`
- `PausableUpgradeable`: namespaced at `keccak256("openzeppelin.storage.Pausable")`

### Contract State Variables (sequential from slot 0)

| Slot | Variable | Type |
|------|----------|------|
| 0 | `giveProtocolTreasury` | `address` |
| 1 | `charityRegistry` | `CharityRegistry` |
| 2 | `donations` | `mapping(address => mapping(address => uint256))` |
| 3 | `taxReceipts` | `mapping(bytes32 => TaxReceipt)` |
| 4 | `suggestedTipRates` | `uint256[]` (dynamic array) |
| 5 | `platformFeeRate` | `uint256` |
| 6 | `tokenConfigs` | `mapping(address => TokenConfig)` |
| 7 | `totalReceived` | `mapping(address => uint256)` |
| 8-55 | `__gap` | `uint256[48]` |

### Constants (bytecode, no storage slot)
- `BASIS_POINTS` = 10000
- `MINIMUM_DONATION` = 1e15
- `MAX_FEE_RATE` = 500
- `CAP_WINDOW` = 24 hours

---

## PortfolioFunds

### Inherited (OZ Upgradeable — ERC-7201 namespaced)
- `ReentrancyGuardUpgradeable`: namespaced at `keccak256("openzeppelin.storage.ReentrancyGuard")`
- `AccessControlUpgradeable`: namespaced at `keccak256("openzeppelin.storage.AccessControl")`
- `PausableUpgradeable`: namespaced at `keccak256("openzeppelin.storage.Pausable")`

### Contract State Variables (sequential from slot 0)

| Slot | Variable | Type |
|------|----------|------|
| 0 | `portfolioFunds` | `mapping(bytes32 => PortfolioFund)` |
| 1 | `activeFundIds` | `bytes32[]` |
| 2 | `verifiedCharities` | `mapping(address => bool)` |
| 3 | `charityNames` | `mapping(address => string)` |
| 4 | `charityToFunds` | `mapping(address => bytes32[])` |
| 5 | `treasury` | `address` |
| 6 | `platformFeeRate` | `uint256` |
| 7 | `governanceActive` | `bool` |
| 8-57 | `__gap` | `uint256[50]` |

### Constants (bytecode, no storage slot)
- `ADMIN_ROLE` = `keccak256("ADMIN_ROLE")`
- `GOVERNANCE_ROLE` = `keccak256("GOVERNANCE_ROLE")`

---

## CharityScheduledDistribution

### Inherited (OZ Upgradeable — ERC-7201 namespaced)
- `OwnableUpgradeable`: namespaced at `keccak256("openzeppelin.storage.Ownable")`
- `ReentrancyGuardUpgradeable`: namespaced at `keccak256("openzeppelin.storage.ReentrancyGuard")`
- `PausableUpgradeable`: namespaced at `keccak256("openzeppelin.storage.Pausable")`

### Contract State Variables (sequential from slot 0)

| Slot | Variable | Type |
|------|----------|------|
| 0 | `donationSchedules` | `mapping(uint256 => DonationSchedule)` |
| 1 | `nextScheduleId` | `uint256` |
| 2 | `tokenPrices` | `mapping(address => uint256)` |
| 3 | `verifiedCharities` | `mapping(address => bool)` |
| 4 | `treasury` | `address` |
| 5 | `platformFeeRate` | `uint256` |
| 6-55 | `__gap` | `uint256[50]` |

### Constants (bytecode, no storage slot)
- `MAX_FEE_RATE` = 500
- `BASIS_POINTS` = 10000
- `DISTRIBUTION_INTERVAL` = 30 days
- `MIN_DONATION_USD` = 10 * 10^8
- `MAX_MONTHS` = 60
- `MIN_MONTHS` = 1

---

## VolunteerVerification

### Inherited (OZ Upgradeable — ERC-7201 namespaced)
- `OwnableUpgradeable`: namespaced at `keccak256("openzeppelin.storage.Ownable")`
- `ReentrancyGuardUpgradeable`: namespaced at `keccak256("openzeppelin.storage.ReentrancyGuard")`
- `PausableUpgradeable`: namespaced at `keccak256("openzeppelin.storage.Pausable")`

### Contract State Variables (sequential from slot 0)

| Slot | Variable | Type |
|------|----------|------|
| 0 | `charities` | `mapping(address => Charity)` |
| 1 | `applications` | `mapping(bytes32 => VolunteerApplication)` |
| 2 | `volunteerHours` | `mapping(bytes32 => VolunteerHours)` |
| 3-52 | `__gap` | `uint256[50]` |

---

## FiatDonationAttestation

### Inherited (OZ Upgradeable — ERC-7201 namespaced)
- `AccessControlUpgradeable`: namespaced at `keccak256("openzeppelin.storage.AccessControl")`
- `PausableUpgradeable`: namespaced at `keccak256("openzeppelin.storage.Pausable")`

### Contract State Variables (sequential from slot 0)

| Slot | Variable | Type |
|------|----------|------|
| 0 | `attestations` | `mapping(bytes32 => FiatAttestation)` |
| 1 | `processedRefHashes` | `mapping(bytes32 => bool)` |
| 2 | `charities` | `mapping(address => Charity)` |
| 3 | `totalAttestedByCharity` | `mapping(address => mapping(bytes3 => uint256))` |
| 4 | `attestationCount` | `uint256` |
| 5 | `canonicalChainId` | `uint256` |
| 6-55 | `__gap` | `uint256[50]` |

### Constants (bytecode, no storage slot)
- `ADMIN_ROLE` = `keccak256("ADMIN_ROLE")`
- `ATTESTER_ROLE` = `keccak256("ATTESTER_ROLE")`
- `MAX_BATCH_SIZE` = 50

---

## Not Converted (Non-Upgradeable by Design)

- **DonationV3**: Frozen V2 direct donation contract (Board-closed Option A). Non-upgradeable by design (`Ownable`, `ReentrancyGuard`, `Pausable`), points at standalone `CharityRegistry`, and goes to external audit (see [V2_AUDIT_SCOPE.md](V2_AUDIT_SCOPE.md)).
- **CharityRegistry**: Standalone non-upgradeable charity registry (`MVP-SEC-05`).
- **DistributionExecutor**: Not upgradeable. Single `immutable` state variable pointing to CharityScheduledDistribution proxy address.
- **MockERC20**: Test utility, not upgradeable.

---

## Upgrade Safety Notes

- The `@openzeppelin/hardhat-upgrades` plugin automatically validates storage layout on upgrade attempts.
- Never reorder, remove, or change the type of existing state variables.
- New variables must be added **before** the `__gap` array, and `__gap` size reduced accordingly.
- Constants and immutables are safe to add/modify (they live in bytecode, not storage).
