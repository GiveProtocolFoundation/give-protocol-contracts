# Live Upgrade + Registry Migration Runbook

Upgrades the 5 live `DurationDonation` mainnet proxies from V1 (embedded
charity registry, no caps) to V2 (Stage-1 caps/allowlist + standalone
`CharityRegistry`), through each chain's 72h `TimelockController`.

**This runbook covers the tooling and the rehearsal. Nothing here runs
automatically: the mutating commands are gated behind the `verified` flag and
only execute when you run them.**

## What this changes (and what it does not)

Three chained timelock ops, executed in order (order is enforced on-chain via
TimelockController predecessors):

1. `upgradeToAndCall(newImpl, initializeV2(tokens, configs))` — installs the
   per-token caps/allowlist atomically with the upgrade.
2. `setCharityRegistry(registry)` — wires the standalone registry.
3. `registerCharities(registry, list)` — migrates the vetted charity set.

Deliberately **not** touched: `platformFeeRate` stays at its current on-chain
value (100 bps). The 50 bps fee change is a separate, gated decision and a
separate live op.

## Addresses (verified read-only 2026-11-17)

All five proxies respond on-chain with `owner() == timelock`,
`minDelay == 259200`, `platformFeeRate() == 100`, and the V1 implementation
slot. Ethereum, Arbitrum, Polygon and Avalanche share the **same** proxy/timelock
addresses because the same deployer key deployed at the same nonces
(deterministic CREATE); Base used a different key and has its own addresses.
The identical values in `deployments/*.json` are therefore correct, not a
copy-paste error.

| Chain | proxy | timelock |
|---|---|---|
| Base | `0x712461A7dFc0bf480023bbCB492F97F7c9d40A54` | `0xB08DC3A8D3d0a003a8cafC0a8b01ec7D024FDb74` |
| Polygon | `0x4B72749185Af4d49bd239b8Eb5D507Ee235de926` | `0xCF213aDFa7e67b80c3Be4e7FEb57038531A5011e` |
| Ethereum | `0x4B72749185Af4d49bd239b8Eb5D507Ee235de926` | `0xCF213aDFa7e67b80c3Be4e7FEb57038531A5011e` |
| Arbitrum | `0x4B72749185Af4d49bd239b8Eb5D507Ee235de926` | `0xCF213aDFa7e67b80c3Be4e7FEb57038531A5011e` |
| Avalanche | `0x4B72749185Af4d49bd239b8Eb5D507Ee235de926` | `0xCF213aDFa7e67b80c3Be4e7FEb57038531A5011e` |

Other places the addresses appear: `deployments/addresses.json`, the webapp
hosting env (`VITE_<CHAIN>_DONATION_ADDRESS`, resolved in
`src/config/env.ts`), and the block explorers (`owner()` on the proxy).

## Keys and gas (informational)

You sign the timelock ops with the keys that hold `PROPOSER_ROLE` /
`EXECUTOR_ROLE`. Read-only role probes (2026-11-17) show those roles are held by
plain EOA keys, not a multisig:

| Chain | proposer/executor | native balance | est. upgrade gas |
|---|---|---|---|
| Base | `0x47bC8683…De81` | 0.0099 ETH | 0.00003 ETH |
| Polygon | `0x399B5C9f…8266` | 4.63 POL | ~1.04 POL |
| Ethereum | `0x399B5C9f…8266` | 0.019 ETH | 0.0006 ETH |
| Arbitrum | `0x399B5C9f…8266` | 0.0104 ETH | 0.0001 ETH |
| Avalanche | `0x399B5C9f…8266` | 0.49 AVAX | 0.039 AVAX |

Gas is covered on every chain (Polygon is the tightest at ~4.5×). No new wallets
are needed; use the two existing keys. Moving the roles to a hardware wallet or
Safe is optional hardening you can do later — it is not a precondition.

## Wallet checklist (what you actually need)

- You do **not** create new wallets for the upgrade. `deploy-*`, `schedule` and
  `execute` sign with the existing timelock proposer/executor keys:
  `0x399B…8266` (Polygon, Ethereum, Arbitrum, Avalanche) and `0x47bC…De81`
  (Base).
- Each key needs gas on its chain — covered today (table above).
- The new implementation and `CharityRegistry` are plain deployments; any
  funded EOA can deploy them, but using the proposer key keeps custody simple.
- Key management is worth hardening separately: these are hot EOAs with no
  multisig. A later optional step (not part of this upgrade) is to move
  `PROPOSER_ROLE`/`EXECUTOR_ROLE` to a hardware wallet or Safe.
- For the charity migration you **do** need real charity payout wallets. The
  live set is currently the placeholder `0x1111…`/`0x2222…` addresses. Those are
  the charities' own wallets (or, for the GPF pilot, a GPF-controlled address)
  and must come from your own vetted payout list — never invented.

## Storage-layout compatibility (why the upgrade is safe)

V1 (live, commit `f29acba`) → V2 (merged caps + registry) variable layout:

| Slot | V1 | V2 | Effect |
|---|---|---|---|
| 0 | `giveProtocolTreasury` (address) | same | preserved |
| 1 | `charities` (mapping) | `charityRegistry` (CharityRegistry) | old mapping orphaned (base slot 0 → 0) |
| 2 | `donations` (mapping) | same | preserved |
| 3 | `taxReceipts` (mapping) | same | preserved |
| 4 | `suggestedTipRates` (uint256[]) | same | preserved |
| 5 | `platformFeeRate` (uint256) | same | preserved |
| 6 | `__gap[0]` | `tokenConfigs` (mapping) | gap (0) → mapping base (0) |
| 7 | `__gap[1]` | `totalReceived` (mapping) | gap (0) → mapping base (0) |
| 8–55 | `__gap[2..49]` | `__gap[0..47]` | gap shrinks 50 → 48 |

No variable is reordered or re-typed at a live slot. The only semantic change
is slot 1: the embedded registry becomes unreachable, which is exactly why op 3
(re-register the vetted set in the standalone registry) exists.

This is verified mechanically by `test/StorageMigration.test.js`, which drives
the real op chain against a proxy deployed with the reconstructed V1
implementation (`contracts/legacy/DurationDonationV1.sol`).

## Operational window (important)

Between executing op 1 and op 3, `_requireActiveCharity` reads the new registry,
which is empty, so **donations revert** until migration completes. Because the
three ops are chained and scheduled in one batch, this window is the ~few
seconds between three back-to-back executions, not 72h. Do not split the batch.

## Token caps (Stage-1 allowlist)

`DurationDonation` has no price oracle, so caps are stored in **token units**.
Converted from USD 500/tx and USD 2,500/24h at 90-day average prices (CoinGecko
daily samples): ETH $2,416.92, POL $0.0981, AVAX $8.868, ARB $0.164. Values are
truncated down (conservative); at current spot they are worth ~$370–420.

| Asset | decimals | per-tx cap | 24h cap |
|---|---|---|---|
| ETH / WETH | 18 | 0.2068 | 1.0343 |
| POL | 18 | 5096.8399 | 25484.1997 |
| AVAX / WAVAX | 18 | 56.3824 | 281.9124 |
| ARB | 18 | 3048.7804 | 15243.9024 |
| DAI | 18 | 500 | 2500 |
| USDC / USDT | 6 | 500 | 2500 — **not usable**, see below |

Wei strings are in `deployments/upgrade-config.json` per chain.

Two exclusions are encoded in the config:

- Native `address(0)` is **disabled**: the webapp donates ERC-20 only
  (`src/hooks/web3/useDonation.ts` throws "Native token donations not yet
  supported"), so enabling it would only widen the cap surface.
- USDC/USDT (6 decimals) are **disabled**: `MINIMUM_DONATION` is a hardcoded
  `1e15` token units, so a $100 USDC donation (100e6) always reverts. This is a
  pre-existing V1 bug that a future V2 must fix with a per-token minimum.

Because caps are per-token, the aggregate daily ceiling is N × USD 2,500 for N
enabled tokens on a chain (Base/Ethereum/Polygon/Avalanche: 2 → $5,000/day;
Arbitrum: 3 → $7,500/day). If you want a tighter aggregate, enable fewer
tokens or lower the per-token caps. Recalibrate quarterly via the timelocked
`setTokenConfig` op.

## Inputs before scheduling

Two inputs remain:

- `charities` — your real payout set. Do NOT copy the placeholder `0x1111…`
  set from the untracked Base script.
- Flip `verified: true` per chain once you have confirmed the addresses/keys and
  `validate` passes; that is the only thing between a `plan` and a `schedule`.

## Procedure (per chain)

```bash
npm run compile
node scripts/live-upgrade.cjs status base      # read-only pre-flight
node scripts/live-upgrade.cjs validate base     # live assertions (owner==timelock, minDelay, roles)
# → confirm addresses/keys, then set "verified": true for that chain
node scripts/live-upgrade.cjs deploy-impl base
node scripts/live-upgrade.cjs deploy-registry base
node scripts/live-upgrade.cjs plan base         # dry-run: calldata + opIds + predecessor chain
node scripts/live-upgrade.cjs schedule base     # schedules 3 chained ops (signer = proposer)
# … wait 72h …
node scripts/live-upgrade.cjs execute base      # executes in order (signer = executor)
node scripts/live-upgrade.cjs verify base       # impl slot + caps + registry + donation simulation
```

## Rehearsal (already run)

- `test/UpgradeScript.test.js` — calldata/op-id correctness vs the real ABI and
  `TimelockController.hashOperation`.
- `test/StorageMigration.test.js` — full V1 → V2 upgrade + migration on a
  reconstructed V1 proxy; proves storage preservation (slots 0/2/5) and that a
  donation works post-migration. **This is the primary rehearsal** (offline and
  deterministic).
- Live read-only `status`/`validate` against **all five** mainnet chains
  (2026-11-17): owner==timelock, minDelay 72h, proposer/executor roles, old V1
  impl (no `charityRegistry`/`tokenConfigs` yet).

An optional mainnet-fork rehearsal (no keys; impersonation + time travel) is
provided in `scripts/rehearse-upgrade-fork.cjs`:

```bash
HARDHAT_FORK_URL=https://<rpc> REHEARSE_CHAIN=base \
  npx hardhat run scripts/rehearse-upgrade-fork.cjs
```

Note: Hardhat's EDR needs a hardfork-activation history for non-Ethereum chains,
so an OP-stack chain such as Base may require an archive node plus a `chains`
entry in `hardhat.config.cjs` before the fork boots. The deterministic
`StorageMigration.test.js` does not depend on forking and is the authoritative
check.

## Ops records

Each mutating command writes `deployments/upgrade-ops-<chain>.json`
(implementation + registry addresses, op ids, tx hashes, block numbers).
Commit these under `deployments/` as the audit trail. Never commit a private key.
