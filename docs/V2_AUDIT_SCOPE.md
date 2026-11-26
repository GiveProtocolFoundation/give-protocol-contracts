# V2 Frozen Scope — External Audit Readiness (GIV-1036 / GIV-1044)

**Status:** Frozen V2 Candidate Scope  
**Architecture Direction:** Board-Closed Option A (Non-Upgradeable V2 Donation Contract + Standalone Non-Upgradeable CharityRegistry)  
**Target Compiler:** Solidity `0.8.22` (Optimizer: enabled, 200 runs)  
**OpenZeppelin Dependency:** `@openzeppelin/contracts` `5.4.0`

---

## 1. Executive Summary

Per the Board-closed engineering direction (2026-10-19) and MVP Engineering Plan §3 (`GIV-1033` / `GIV-1044`), Give Protocol's V2 direct donation architecture moves to a **strictly non-upgradeable** model (**Option A** — no UUPS proxy, no `Initializable`, no storage gap).

The V2 audit scope bundles four mandatory MVP requirements into a frozen, self-contained contract pair:
1. **`contracts/CharityRegistry.sol` (MVP-SEC-05):** Standalone, non-upgradeable registry of verified charity addresses owned by the 72-hour `TimelockController`. Decouples charity registration state from donation processing so future donation contract deployments never require re-registering charities.
2. **`contracts/DonationV3.sol` (GIV-1044):** Standalone, non-upgradeable V2 donation contract consuming `CharityRegistry`.
   - **MVP-DON-04 (Cause/Program Identifier):** Threads `bytes32 causeId` through ERC20 and native donation entry points, tax receipts, and emits `causeId` (indexed) in `DonationProcessed`. Backwards-compatible overloads default `causeId` to `bytes32(0)`.
   - **MVP-SEC-02 (Per-Token Allowlist & Caps):** Enforces a deny-by-default token allowlist (`tokenConfigs[token].enabled == false` unless explicitly enabled) alongside a per-transaction principal cap (`perTxCap > 0`) and a rolling 24-hour (`CAP_WINDOW = 24 hours`) cumulative principal cap (`dailyCap >= perTxCap`). Stage-1 reference parameters: `$500` / tx (`500` token units) and `$2,500` / 24h (`2,500` token units).
   - **MVP-DON-02 (0.5% Platform Fee Invariant):** Hard-sets `platformFeeRate = 50` (50 bps = 0.5%, `DEFAULT_FEE_RATE = 50`) in the constructor with an on-chain `assert(platformFeeRate == 50)` post-init check, and asserts `platformFeeRate() == 50` post-deploy in `scripts/deploy-universal.cjs`.

---

## 2. Frozen Files in Scope for External Audit (GIV-1036)

| File | Role | Upgradeability | Governance Owner |
|------|------|----------------|------------------|
| `contracts/CharityRegistry.sol` | Canonical per-chain charity registration & active-status registry | **Non-upgradeable** (`Ownable`) | 72h `TimelockController` |
| `contracts/DonationV3.sol` | Direct ERC20 & native donation processor with causeId, per-token caps/allowlist, and on-chain tax receipts | **Non-upgradeable** (`Ownable`, `ReentrancyGuard`, `Pausable`) | 72h `TimelockController` |
| `contracts/GiveTimelockController.sol` | OpenZeppelin `TimelockController` artifact wrapper used for 72h fund-holding governance | **Non-upgradeable** | Self-governing (multisig proposer/executor) |

### Legacy / Sibling Contracts (Context Only)
- `contracts/DurationDonation.sol`: V1 UUPS upgradeable donation contract (retained for V1 storage-layout and upgrade regression tests; live V1 proxy mutations remain frozen under `GIV-1035`).
- `contracts/PortfolioFunds.sol`, `contracts/CharityScheduledDistribution.sol`, `contracts/DistributionExecutor.sol`, `contracts/VolunteerVerification.sol`, `contracts/FiatDonationAttestation.sol`: Separate protocol modules outside the V2 direct-donation replacement pair.

---

## 3. Core Invariants & Security Properties (`DonationV3`)

1. **No Upgrade Surface (Option A):**
   - `DonationV3` inherits only from `@openzeppelin/contracts/access/Ownable.sol`, `ReentrancyGuard.sol`, and `Pausable.sol`.
   - It contains no `delegatecall`, no `UUPSUpgradeable`, no `Initializable`, and no `_authorizeUpgrade`.
2. **Settlement Conservation & Fee Precision (MVP-DON-02):**
   - For every ERC20 donation of principal `charityAmount` and optional `platformTip`:
     - `mandatoryFee = (charityAmount * platformFeeRate) / 10000`
     - `netToCharity = charityAmount - mandatoryFee`
     - `totalToTreasury = mandatoryFee + platformTip`
     - `netToCharity + totalToTreasury == charityAmount + platformTip` (exact conservation; zero dust retained by `DonationV3`).
   - For every native donation with `msg.value` and `platformTip <= msg.value`:
     - `charityAmount = msg.value - platformTip`
     - `netToCharity + totalToTreasury == msg.value` (exact conservation; contract holds zero balance after execution).
   - `platformFeeRate` is initialized to `50` (0.5%) and asserted via `assert(platformFeeRate == 50)` in the constructor, bounded above by `MAX_FEE_RATE = 500` (5%).
3. **Deny-by-Default Token Allowlist & Rolling 24h Caps (MVP-SEC-02):**
   - Every token address (including `address(0)` for native currency) defaults to `enabled = false`.
   - `_checkTokenCaps(token, charityAmount)` executes prior to any external token/native transfer (Checks-Effects-Interactions):
     - Reverts with `TokenNotAllowed(token)` if `!cfg.enabled`.
     - Reverts with `ExceedsPerTxCap(token, charityAmount, cfg.perTxCap)` if `charityAmount > cfg.perTxCap`.
     - Resets `cfg.dailyWindowStart = block.timestamp` and `cfg.dailyVolume = 0` when `block.timestamp >= cfg.dailyWindowStart + 24 hours`.
     - Reverts with `ExceedsDailyCap(token, charityAmount, cfg.dailyVolume, cfg.dailyCap)` if `cfg.dailyVolume + charityAmount > cfg.dailyCap`.
4. **Separated Charity Validation (MVP-SEC-05):**
   - `_requireActiveCharity(charity)` queries `charityRegistry.isRegistered(charity)` and `charityRegistry.isActive(charity)` on the standalone `CharityRegistry`.
   - `charityRegistry` is set either at construction or once via `setCharityRegistry` (`require(address(charityRegistry) == address(0))`) and cannot be repointed afterward.
5. **Cause / Program Attribution (MVP-DON-04):**
   - `DonationProcessed` emits `(donor, charity, token, netToCharity, totalToTreasury, totalTaxDeductible, timestamp, donationId, causeId)` with `donor`, `charity`, and `causeId` indexed.
   - `TaxReceipt` stores `causeId` on-chain alongside beneficiary and tax-deductible totals.
6. **Reentrancy & Checks-Effects-Interactions:**
   - All donation entry points are guarded by `nonReentrant` and `whenNotPaused`.
   - Rolling cap state (`dailyVolume`, `dailyWindowStart`), `totalReceived`, `donations`, `_donationNonce`, and `taxReceipts` are updated before external token or native transfers.

---

## 4. Verification & Test Suite

- **Unit & Invariant Tests:** `test/DonationV3.test.js` covers:
  - Non-upgradeability surface check (`upgradeToAndCall`, `initialize`, `proxiableUUID` absent).
  - Constructor initialization, `platformFeeRate == 50` assertion, and deferred set-once `CharityRegistry` wiring.
  - `causeId` emission across ERC20 (`processDonation`, `processDonationWithPercentageTip`, `processDonationWithSuggestedTip`) and native (`donateNative`) paths, plus backwards-compatible `bytes32(0)` overloads.
  - Standalone `CharityRegistry` consumption and multi-instance registry sharing without re-registering charities.
  - Deny-by-default token allowlist, Stage-1 per-tx cap (`500` units), rolling-24h daily cap (`2,500` units), window expiry reset, batch config updates, and pause/unpause controls.
- **Registry Tests:** `test/CharityRegistry.test.js` verifies standalone registry deployment, registration, batch migration, status updates, and ownership transfer.
