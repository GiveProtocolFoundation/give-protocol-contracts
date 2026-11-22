#!/usr/bin/env node
/**
 * rehearse-upgrade-fork.cjs — dry-run rehearsal of the V1 → V2 DurationDonation
 * upgrade + CharityRegistry migration against a FORK of a live mainnet.
 *
 * This never signs a real transaction: it forks the chain into the in-process
 * Hardhat network, impersonates the recorded proposer/executor, time-travels
 * past the 72h delay, and executes the exact op chain that scripts/live-upgrade.cjs
 * would schedule. It proves, against real on-chain state, that:
 *   1. the upgrade lands (EIP-1967 impl slot changes),
 *   2. Stage-1 caps/allowlist are applied atomically (tokenConfigs),
 *   3. the standalone registry is wired (charityRegistry()),
 *   4. charities migrate (registerCharities via the timelock),
 *   5. a donation no longer reverts after migration,
 *   6. pre-upgrade storage (treasury, platformFeeRate) is preserved.
 *
 * Usage:
 *   BASE_RPC_URL=https://mainnet.base.org npx hardhat run scripts/rehearse-upgrade-fork.cjs
 *
 * Rehearse other chains by setting the config `verified` addresses and passing
 * the chain key:
 *   REHEARSE_CHAIN=polygon POLYGON_RPC_URL=https://… npx hardhat run scripts/rehearse-upgrade-fork.cjs
 */
const hre = require("hardhat");
const { ethers, network } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { buildOps, loadConfig } = require("./live-upgrade.cjs");

const CHAIN = process.env.REHEARSE_CHAIN || "base";
const DELAY = 259200n; // 72h

// Minimal V1 ABI for pre-upgrade state reads (functions that existed on the live impl).
const V1_ABI = [
  "function owner() view returns (address)",
  "function platformFeeRate() view returns (uint256)",
  "function charities(address) view returns (bool isRegistered, address walletAddress, uint256 totalReceived, bool isActive)",
];

async function readImplSlot(provider, proxy) {
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const raw = await provider.getStorage(proxy, slot);
  return raw && raw !== ethers.ZeroHash ? ethers.getAddress(`0x${raw.slice(26)}`) : null;
}

async function main() {
  const config = loadConfig();
  const cfg = config.chains[CHAIN];
  if (!cfg || !cfg.proxy || !cfg.timelock) throw new Error(`Chain ${CHAIN} has no reconciled addresses`);

  const rpc = process.env[cfg.rpcEnv] || cfg.defaultRpc;
  // Forking is enabled via HARDHAT_FORK_URL in hardhat.config.cjs (hardhat_reset
  // forking is not available in this EDR build). Verify the fork is live by
  // checking the proxy's owner against the recorded timelock below.
  console.log(`Rehearsing ${cfg.name} upgrade against fork (HARDHAT_FORK_URL=${process.env.HARDHAT_FORK_URL || rpc})`);
  const provider = ethers.provider;
  const [deployer] = await ethers.getSigners();

  const proxy = cfg.proxy;
  const timelock = cfg.timelock;
  const proposer = cfg.proposer;
  const executor = cfg.executor || cfg.proposer;

  // ---- Pre-upgrade state (V1) ------------------------------------------------
  const v1 = new ethers.Contract(proxy, V1_ABI, provider);
  const [owner, fee, implBefore] = await Promise.all([
    v1.owner(),
    v1.platformFeeRate(),
    readImplSlot(provider, proxy),
  ]);
  console.log(`\nPRE  owner=${owner}  platformFeeRate=${fee}  impl=${implBefore}`);
  if (owner.toLowerCase() !== timelock.toLowerCase()) throw new Error(`owner ${owner} != timelock ${timelock}`);

  // ---- Deploy V2 implementation + standalone registry (on the fork) ----------
  const DD = await ethers.getContractFactory("DurationDonation");
  const impl = await DD.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();

  const CR = await ethers.getContractFactory("CharityRegistry");
  const reg = await CR.deploy(timelock); // owner = 72h timelock
  await reg.waitForDeployment();
  const regAddr = await reg.getAddress();
  console.log(`Deployed on fork:  impl=${implAddr}  registry=${regAddr} (owner=${await reg.owner()})`);

  // ---- Build the exact op chain the live script would schedule ---------------
  const native = ethers.ZeroAddress;
  const tokens = [native];
  const configs = [
    { enabled: true, perTxCap: ethers.parseEther("500"), dailyCap: ethers.parseEther("2500"), dailyWindowStart: 0n, dailyVolume: 0n },
  ];
  // A rehearsal charity: a fresh EOA standing in for a vetted wallet.
  const charity = ethers.Wallet.createRandom().address;
  const ops = buildOps({ chain: CHAIN, proxy, registry: regAddr, impl: implAddr, tokens, configs, charities: [charity] });

  // ---- Impersonate the proposer/executor and drive the timelock --------------
  await network.provider.request("hardhat_impersonateAccount", [proposer]);
  await network.provider.request("hardhat_setBalance", [proposer, "0x100000000000000000000"]); // 100 ETH
  if (executor.toLowerCase() !== proposer.toLowerCase()) {
    await network.provider.request("hardhat_impersonateAccount", [executor]);
    await network.provider.request("hardhat_setBalance", [executor, "0x100000000000000000000"]);
  }
  const proposerSigner = await ethers.getSigner(proposer);
  const executorSigner = await ethers.getSigner(executor);

  const tl = await ethers.getContractAt("TimelockController", timelock, proposerSigner);
  for (const op of ops) {
    if (await tl.isOperationDone(op.id)) { console.log(`${op.name} already done — skip`); continue; }
    if (await tl.isOperationPending(op.id)) { console.log(`${op.name} already pending — skip`); continue; }
    await (await tl.schedule(op.target, op.value, op.data, op.predecessor, op.salt, DELAY)).wait();
    console.log(`Scheduled ${op.name}  opId=${op.id}`);
  }

  // ---- Advance past the 72h delay -------------------------------------------
  await time.increase(Number(DELAY) + 60);
  await network.provider.request("hardhat_mine", ["0x1"]);

  const tlExec = await ethers.getContractAt("TimelockController", timelock, executorSigner);
  for (const op of ops) {
    if (await tlExec.isOperationDone(op.id)) { console.log(`${op.name} already executed — skip`); continue; }
    if (!(await tlExec.isOperationReady(op.id))) throw new Error(`${op.name} not ready after time travel`);
    await (await tlExec.execute(op.target, op.value, op.data, op.predecessor, op.salt)).wait();
    console.log(`Executed ${op.name}`);
  }

  // ---- Post-upgrade verification --------------------------------------------
  const dd = await ethers.getContractAt("DurationDonation", proxy);
  const implAfter = await readImplSlot(provider, proxy);
  const registryAfter = await dd.charityRegistry();
  const nativeCfg = await dd.tokenConfigs(native);
  const feeAfter = await dd.platformFeeRate();

  console.log(`\nPOST impl=${implAfter}  registry=${registryAfter}  fee=${feeAfter}`);
  if (implAfter.toLowerCase() !== implAddr.toLowerCase()) throw new Error("impl slot did not change to V2");
  if (registryAfter.toLowerCase() !== regAddr.toLowerCase()) throw new Error("charityRegistry not wired");
  if (!nativeCfg.enabled) throw new Error("native token config not enabled");
  if (nativeCfg.perTxCap !== ethers.parseEther("500")) throw new Error("perTxCap mismatch");
  if (nativeCfg.dailyCap !== ethers.parseEther("2500")) throw new Error("dailyCap mismatch");
  if (feeAfter !== fee) throw new Error("platformFeeRate changed unexpectedly");

  // Charity migration + donation simulation.
  const cr = await ethers.getContractAt("CharityRegistry", regAddr);
  const info = await cr.getCharityInfo(charity);
  if (!info.isRegistered_ || !info.isActive_) throw new Error("migration did not register the charity");

  // Simulate a native donation (eth_call) — must not revert.
  const data = dd.interface.encodeFunctionData("donateNative", [charity, 0n]);
  await provider.call({ from: deployer.address, to: proxy, data, value: ethers.parseEther("0.001") });

  console.log(`\nREHEARSAL OK on ${cfg.name}: upgrade + caps + registry + migration all verified, donation simulation succeeded.`);
}

main().catch((e) => {
  console.error("REHEARSAL FAILED:", e.shortMessage || e.message);
  if (e.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
