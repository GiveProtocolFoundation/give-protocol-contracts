# Upgrade Runbook — Give Protocol Contracts

## Pre-Upgrade Checklist

1. [ ] New implementation compiles cleanly (`npm run compile`)
2. [ ] All tests pass (`npm test`)
3. [ ] Storage layout validated (hardhat-upgrades checks automatically)
4. [ ] Changes reviewed by at least 2 team members
5. [ ] New implementation deployed and verified on testnet first
6. [ ] No active fund claims or distributions in progress

## Contract → Timelock Mapping

| Contract | Category | Timelock Delay | Upgrade Guard |
|---|---|---|---|
| DurationDonation | Fund-holding | 72h | `onlyOwner` (owner = 72h timelock) |
| PortfolioFunds | Fund-holding | 72h | `onlyRole(DEFAULT_ADMIN_ROLE)` (role held by 72h timelock) |
| CharityScheduledDistribution | Fund-holding | 72h | `onlyOwner` (owner = 72h timelock) |
| VolunteerVerification | Record-keeping | 24h | `onlyOwner` (owner = 24h timelock) |
| FiatDonationAttestation | Record-keeping | 24h | `onlyRole(DEFAULT_ADMIN_ROLE)` (role held by 24h timelock) |
| DistributionExecutor | Not upgradeable | N/A | N/A |

## Upgrade Procedure

### Fund-Holding Contracts (DurationDonation, PortfolioFunds, CharityScheduledDistribution)

#### 1. Deploy new implementation

```bash
# Deploy the new implementation contract (without proxy)
npx hardhat run scripts/deploy-implementation.cjs --network <network>
```

Or manually via Hardhat console:

```javascript
const V2 = await ethers.getContractFactory("DurationDonation");
const v2 = await V2.deploy();
await v2.waitForDeployment();
console.log("New implementation:", await v2.getAddress());
```

#### 2. Propose upgrade through TimelockController (via multi-sig)

Encode the `upgradeToAndCall` call:

```javascript
const proxy = await ethers.getContractAt("DurationDonation", PROXY_ADDRESS);
const callData = proxy.interface.encodeFunctionData("upgradeToAndCall", [NEW_IMPL_ADDRESS, "0x"]);
```

Schedule through timelock:

```javascript
const timelock = await ethers.getContractAt("TimelockController", TIMELOCK_ADDRESS);
await timelock.schedule(
  PROXY_ADDRESS,     // target
  0,                 // value
  callData,          // data
  ethers.ZeroHash,   // predecessor
  ethers.id("upgrade-v2-description"), // salt
  259200,            // delay (72 hours = 259200 seconds)
);
```

#### 3. Wait 72 hours

The timelock enforces a mandatory waiting period. During this time:
- Community can review the pending upgrade
- Team can cancel if issues are discovered

#### 4. Execute upgrade through TimelockController (via multi-sig)

```javascript
await timelock.execute(
  PROXY_ADDRESS,
  0,
  callData,
  ethers.ZeroHash,
  ethers.id("upgrade-v2-description"),
);
```

#### 5. Post-upgrade verification

```bash
# Check implementation address changed
cast storage <PROXY_ADDRESS> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

# Run targeted test against live proxy
npx hardhat run scripts/verify-upgrade.cjs --network <network>
```

Verify state preservation:
- Call view functions to confirm data is intact
- Check `owner()` / role assignments haven't changed
- Verify the proxy address hasn't changed

### Record-Keeping Contracts (VolunteerVerification, FiatDonationAttestation)

Same procedure as above, with 24-hour delay instead of 72 hours.

## Multi-Sig Coordination Steps

The timelock's proposer and executor roles are held by a multi-sig wallet (e.g., Gnosis Safe). All upgrade operations require coordinated signing.

### Proposing an Upgrade (3-of-5 required)

1. **Initiator** creates a Safe transaction batch containing the `timelock.schedule(...)` call
2. Share the Safe transaction link with all signers via the team's secure channel
3. Each signer independently verifies:
   - The new implementation address matches the audited/reviewed deployment
   - The proxy target address is correct for the intended contract
   - The calldata decodes to `upgradeToAndCall(newImpl, "0x")` (or includes valid reinitializer data)
   - The salt is unique and descriptive
4. Collect 3 of 5 signatures; the final signer executes the Safe transaction
5. Record the timelock operation ID for tracking: `keccak256(abi.encode(target, value, data, predecessor, salt))`

### Executing After Delay

1. After the timelock delay expires, **initiator** creates a Safe transaction for `timelock.execute(...)`
2. Same signing ceremony: 3-of-5 must verify and sign
3. Before signing, each signer should verify the implementation contract is verified on the block explorer

### Cancelling a Pending Upgrade

Any proposer can cancel before execution:
1. Create a Safe transaction for `timelock.cancel(operationId)`
2. Collect 3-of-5 signatures and execute immediately (no delay for cancellation)

## Emergency Procedures

### Pausing

All upgradeable contracts support `pause()`. For fund-holding contracts, pause must go through the timelock:

```javascript
const callData = proxy.interface.encodeFunctionData("pause", []);
await timelock.schedule(PROXY_ADDRESS, 0, callData, ethers.ZeroHash, salt, delay);
// Wait for delay...
await timelock.execute(PROXY_ADDRESS, 0, callData, ethers.ZeroHash, salt);
```

### Critical Vulnerability Response

1. Propose upgrade + request expedited multi-sig signing from all signers
2. Timelock delay still applies — the delay is a security feature, not a bug
3. If the vulnerability allows fund drainage, the pause mechanism is the immediate mitigation

### Cancelling a Pending Upgrade

If an issue is discovered during the timelock delay:

```javascript
await timelock.cancel(operationId);
```

The operation ID can be computed from the schedule parameters.

## Proxy Architecture Reference

```
User → ERC1967Proxy (permanent address) → Implementation (replaceable)
                ↑
        stores state in proxy storage
```

- Proxy address is permanent — this is what the webapp and users interact with
- Implementation address changes on upgrade
- State lives in the proxy's storage, not the implementation's
- The `_authorizeUpgrade` function in each implementation gates who can upgrade

## Per-Contract Post-Upgrade Verification

### DurationDonation
```javascript
// Verify state preserved
await donation.giveProtocolTreasury();   // Should match pre-upgrade value
await donation.platformFeeRate();         // Should be 50 (or current value)
await donation.getSuggestedTipRates();    // Should return [500, 1000, 2000]
await donation.owner();                   // Should be timelock address
// Test a registered charity is still accessible
await donation.getCharityInfo(KNOWN_CHARITY_ADDRESS);
```

### CharityScheduledDistribution
```javascript
await distribution.treasury();            // Should match pre-upgrade value
await distribution.platformFeeRate();     // Should be 50 (or current value)
await distribution.nextScheduleId();      // Should match pre-upgrade value
await distribution.owner();               // Should be timelock address
// Verify an active schedule still exists
await distribution.donationSchedules(KNOWN_SCHEDULE_ID);
```

### PortfolioFunds
```javascript
await portfolioFunds.treasury();          // Should match pre-upgrade value
await portfolioFunds.platformFeeRate();   // Should be 50 (or current value)
await portfolioFunds.governanceActive();  // Should match pre-upgrade value
// Verify roles preserved
const ADMIN_ROLE = await portfolioFunds.ADMIN_ROLE();
await portfolioFunds.hasRole(ADMIN_ROLE, TIMELOCK_ADDRESS); // Should be true
// Verify a fund still exists
await portfolioFunds.getFundDetails(KNOWN_FUND_ID);
```

### VolunteerVerification
```javascript
await verification.owner();               // Should be timelock address
// Verify a known charity registration
await verification.charities(KNOWN_CHARITY_ADDRESS);
// Verify a known application hash
await verification.checkApplicationVerification(KNOWN_APP_HASH);
```

### FiatDonationAttestation
```javascript
await attestation.canonicalChainId();     // Should match network chain ID
await attestation.attestationCount();     // Should match pre-upgrade value
// Verify roles preserved
const DEFAULT_ADMIN = await attestation.DEFAULT_ADMIN_ROLE();
await attestation.hasRole(DEFAULT_ADMIN, TIMELOCK_ADDRESS); // Should be true
// Verify a known attestation
await attestation.getAttestation(KNOWN_ATTESTATION_HASH);
```

## Implementation Slot

The ERC-1967 implementation slot:
```
0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
```

Read current implementation:
```bash
cast storage <PROXY_ADDRESS> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url <RPC_URL>
```
