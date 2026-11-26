#!/usr/bin/env node
/**
 * live-upgrade.cjs — DurationDonation V1 → V2 live upgrade + CharityRegistry
 * migration for the 5 mainnet proxies, executed through each chain's 72h
 * TimelockController.
 *
 * This script is deliberately read-only unless you pass `schedule` / `execute`
 * / `deploy-*`, and those commands refuse to sign with any key other than the
 * recorded proposer (schedule) or executor (execute) for that chain.
 *
 * Commands (chain key is the first argument, e.g. `base`, `polygon`):
 *   node scripts/live-upgrade.cjs status [chain|all]
 *   node scripts/live-upgrade.cjs validate [chain]
 *   node scripts/live-upgrade.cjs plan [chain]
 *   node scripts/live-upgrade.cjs deploy-impl [chain]
 *   node scripts/live-upgrade.cjs deploy-registry [chain]
 *   node scripts/live-upgrade.cjs schedule [chain]
 *   node scripts/live-upgrade.cjs execute [chain]
 *   node scripts/live-upgrade.cjs verify [chain]
 *
 * Operation chain (order is enforced on-chain via TimelockController
 * predecessors, so an op cannot execute before the previous one is done):
 *   1. upgradeToAndCall(newImpl, initializeV2(tokens, configs))  — install Stage-1 caps + allowlist
 *   2. setCharityRegistry(registry)                               — wire the standalone registry
 *   3. registerCharities(registry, charityList)                    — migrate the vetted charity set
 *
 * Config: deployments/upgrade-config.json (chain addresses + signer
 * expectations). Token configs and the charity list live in the same file and
 * are EMPTY by default — `schedule` refuses to run until the operator fills
 * them in (see deployments/upgrade-config.example.json).
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "..", "node_modules", "ethers"));

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "deployments", "upgrade-config.json");

const ARTIFACTS = {
  DurationDonation: require(path.join(
    ROOT,
    "artifacts/contracts/DurationDonation.sol/DurationDonation.json",
  )),
  CharityRegistry: require(path.join(
    ROOT,
    "artifacts/contracts/CharityRegistry.sol/CharityRegistry.json",
  )),
  TimelockController: require(path.join(
    ROOT,
    "artifacts/@openzeppelin/contracts/governance/TimelockController.sol/TimelockController.json",
  )),
};

const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MIN_DELAY = 259200n; // 72 hours
const SALT_PREFIX = "give-protocol-upgrade-v2";
const DONATION_SIMULATION_WEI = 1_000_000_000_000_000n; // 0.001 ETH == MINIMUM_DONATION

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Derive the OZ TimelockController operation id.
 * @returns {string} bytes32 hex
 */
function opId(params) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes", "bytes32", "bytes32"],
      [params.target, params.value, params.data, params.predecessor, params.salt],
    ),
  );
}

/**
 * Encode initializeV2(tokens, configs). configs are full TokenConfig structs:
 * { enabled, perTxCap, dailyCap, dailyWindowStart, dailyVolume }.
 */
function buildInitializeV2Data(iface, tokens, configs) {
  return iface.encodeFunctionData("initializeV2", [tokens, configs]);
}

/** Encode upgradeToAndCall(impl, initData). */
function buildUpgradeData(iface, impl, initData) {
  return iface.encodeFunctionData("upgradeToAndCall", [impl, initData]);
}

/** Encode setCharityRegistry(registry). */
function buildSetRegistryData(iface, registry) {
  return iface.encodeFunctionData("setCharityRegistry", [registry]);
}

/** Encode registerCharities(address[]). */
function buildRegisterData(iface, list) {
  return iface.encodeFunctionData("registerCharities", [list]);
}

/**
 * Build the three chained ops for a chain. Order enforced by predecessor.
 * @returns {Array<{name, target, value, data, predecessor, salt, id}>}
 */
function buildOps({ chain, proxy, registry, impl, tokens, configs, charities }) {
  const dd = new ethers.Interface(ARTIFACTS.DurationDonation.abi);
  const cr = new ethers.Interface(ARTIFACTS.CharityRegistry.abi);

  const initData = buildInitializeV2Data(dd, tokens, configs);
  const upgradeData = buildUpgradeData(dd, impl, initData);
  const setRegistryData = buildSetRegistryData(dd, registry);
  const registerData = buildRegisterData(cr, charities);

  const op1 = {
    name: "upgrade-to-v2",
    target: proxy,
    value: 0n,
    data: upgradeData,
    predecessor: ethers.ZeroHash,
    salt: ethers.id(`${SALT_PREFIX}-${chain}-impl`),
  };
  op1.id = opId(op1);

  const op2 = {
    name: "wire-charity-registry",
    target: proxy,
    value: 0n,
    data: setRegistryData,
    predecessor: op1.id,
    salt: ethers.id(`${SALT_PREFIX}-${chain}-registry`),
  };
  op2.id = opId(op2);

  const op3 = {
    name: "migrate-charities",
    target: registry,
    value: 0n,
    data: registerData,
    predecessor: op2.id,
    salt: ethers.id(`${SALT_PREFIX}-${chain}-migrate`),
  };
  op3.id = opId(op3);

  return [op1, op2, op3];
}

// ---------------------------------------------------------------------------
// Config / ops-record IO
// ---------------------------------------------------------------------------

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

/** Per-chain token config with a top-level fallback (legacy configs). */
function chainTokens(cfg, config) {
  return cfg.tokens || config.tokens || [];
}

/** Per-chain charity list with a top-level fallback. */
function chainCharities(cfg, config) {
  return cfg.charities || config.charities || [];
}

function opsFile(chain) {
  return path.join(ROOT, "deployments", `upgrade-ops-${chain}.json`);
}

function loadOps(chain) {
  const f = opsFile(chain);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { chain, ops: {} };
}

function saveOps(chain, record) {
  fs.writeFileSync(opsFile(chain), JSON.stringify(record, null, 2));
}

function chainKeys(config) {
  return Object.keys(config.chains);
}

function chainArg(config, argv) {
  const explicit = argv[3];
  if (explicit && config.chains[explicit]) return [explicit];
  if (explicit && explicit !== "all") throw new Error(`Unknown chain "${explicit}"`);
  return chainKeys(config);
}

function providerFor(cfg) {
  const url = process.env[cfg.rpcEnv] || cfg.defaultRpc;
  if (!url) throw new Error(`No RPC for chain ${cfg.name} (env ${cfg.rpcEnv} or defaultRpc)`);
  return new ethers.JsonRpcProvider(url, cfg.chainId, { staticNetwork: true });
}

/** Mutation gate: refuse to spend gas / mutate live state until the operator has
 * reviewed `validate` and marked the chain verified in the config. */
function requireVerified(cfg) {
  if (cfg.verified !== true) {
    throw new Error(
      `${cfg.name}: not marked verified (verified:true) in upgrade-config.json. ` +
        `Run \`node scripts/live-upgrade.cjs validate ${cfg.name}\`, confirm the addresses ` +
        `and that you control the signer key, then set verified:true.`,
    );
  }
}

/** Load and strictly check a signer against the expected address + role. */
function signerFor(cfg, expectedAddr, what) {
  const pk = process.env[cfg.pkEnv] || process.env.PRIVATE_KEY;
  if (!pk) throw new Error(`No key for ${cfg.name} (env ${cfg.pkEnv} or PRIVATE_KEY)`);
  const wallet = new ethers.Wallet(pk);
  if (!expectedAddr) throw new Error(`${cfg.name}: no ${what} address recorded — refusing to sign`);
  if (wallet.address.toLowerCase() !== expectedAddr.toLowerCase()) {
    throw new Error(
      `${cfg.name}: loaded key derives ${wallet.address}, but the recorded ${what} is ${expectedAddr}. Refusing to sign with any other key.`,
    );
  }
  return wallet;
}

// ---------------------------------------------------------------------------
// Chain contract handles
// ---------------------------------------------------------------------------

function handles(cfg, provider) {
  const tl = new ethers.Contract(
    cfg.timelock,
    ARTIFACTS.TimelockController.abi,
    provider,
  );
  const dd = new ethers.Contract(cfg.proxy, ARTIFACTS.DurationDonation.abi, provider);
  const cr = cfg.registry
    ? new ethers.Contract(cfg.registry, ARTIFACTS.CharityRegistry.abi, provider)
    : null;
  return { tl, dd, cr };
}

/** Read the EIP-1967 implementation slot (returns checksummed address or null). */
async function readImplSlot(provider, proxy) {
  const raw = await provider.getStorage(proxy, EIP1967_IMPL_SLOT);
  if (!raw || raw === ethers.ZeroHash) return null;
  return ethers.getAddress(`0x${raw.slice(26)}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStatus(config, keys) {
  for (const key of keys) {
    const cfg = config.chains[key];
    console.log(`\n=== ${cfg.name} (${key}, chainId ${cfg.chainId}) ===`);
    if (!cfg.proxy || !cfg.timelock) {
      console.log("  MISSING proxy/timelock addresses — reconcile before use.");
      continue;
    }
    const provider = providerFor(cfg);
    const dd = new ethers.Contract(cfg.proxy, ARTIFACTS.DurationDonation.abi, provider);
    const tl = new ethers.Contract(cfg.timelock, ARTIFACTS.TimelockController.abi, provider);
    try {
      const [owner, impl, minDelay, proposerRole, executorRole] = await Promise.all([
        dd.owner(),
        readImplSlot(provider, cfg.proxy),
        tl.getMinDelay(),
        tl.PROPOSER_ROLE(),
        tl.EXECUTOR_ROLE(),
      ]);
      console.log(`  proxy        ${cfg.proxy}`);
      console.log(`  owner        ${owner}  ${owner.toLowerCase() === cfg.timelock.toLowerCase() ? "[OK == timelock]" : "[WARN != timelock]"}`);
      console.log(`  impl slot    ${impl ?? "NOT A PROXY / unreadable"}`);
      console.log(`  timelock     ${cfg.timelock}  minDelay=${minDelay}  ${BigInt(minDelay) >= MIN_DELAY ? "[OK >= 72h]" : "[WARN < 72h]"}`);
      console.log(`  proposer     ${cfg.proposer ?? "unset"}  ${cfg.proposer ? (await tl.hasRole(proposerRole, cfg.proposer)) ? "[OK has role]" : "[WARN no role]" : ""}`);
      console.log(`  executor     ${cfg.executor ?? "unset"}  ${cfg.executor ? (await tl.hasRole(executorRole, cfg.executor)) ? "[OK has role]" : "[WARN no role]" : ""}`);
      try {
        const reg = await dd.charityRegistry();
        console.log(`  registry     ${reg === ethers.ZeroAddress ? "(not set)" : reg}`);
      } catch (e) {
        console.log(`  registry     (function absent → old V1 impl, as expected pre-upgrade)`);
      }
      try {
        const tc = await dd.tokenConfigs(ethers.ZeroAddress);
        console.log(`  tokenConfigs(address(0))  enabled=${tc.enabled} perTxCap=${tc.perTxCap} dailyCap=${tc.dailyCap} ${tc.enabled ? "[caps LIVE]" : "[deny-by-default]"}`);
      } catch (e) {
        console.log(`  tokenConfigs(address(0))  (function absent → caps not live)`);
      }
      const ops = buildOpsForChain(key);
      for (const op of ops) {
        const [pending, ready, done] = await Promise.all([
          tl.isOperationPending(op.id),
          tl.isOperationReady(op.id),
          tl.isOperationDone(op.id),
        ]);
        console.log(`  op:${op.name}  pending=${pending} ready=${ready} done=${done}  ${pending || ready ? `eta=${new Date(Number((await tl.getTimestamp(op.id)) * 1000n)).toISOString()}` : ""}`);
      }
    } catch (e) {
      console.log(`  [ERROR] ${e.shortMessage || e.message}`);
    }
  }
}

async function cmdValidate(config, keys) {
  let failed = false;
  for (const key of keys) {
    const cfg = config.chains[key];
    console.log(`\n=== validate ${cfg.name} ===`);
    const problems = [];
    if (!cfg.proxy || !cfg.timelock) problems.push("missing proxy/timelock");
    if (!problems.length) {
      const provider = providerFor(cfg);
      const dd = new ethers.Contract(cfg.proxy, ARTIFACTS.DurationDonation.abi, provider);
      const tl = new ethers.Contract(cfg.timelock, ARTIFACTS.TimelockController.abi, provider);
      try {
        const owner = await dd.owner();
        if (owner.toLowerCase() !== cfg.timelock.toLowerCase()) problems.push(`proxy owner ${owner} != timelock ${cfg.timelock}`);
        const impl = await readImplSlot(provider, cfg.proxy);
        if (!impl) problems.push("no EIP-1967 impl slot — not a UUPS proxy?");
        const minDelay = await tl.getMinDelay();
        if (BigInt(minDelay) < MIN_DELAY) problems.push(`minDelay ${minDelay} < 72h`);
        if (cfg.proposer && !(await tl.hasRole(await tl.PROPOSER_ROLE(), cfg.proposer))) problems.push(`proposer ${cfg.proposer} lacks PROPOSER_ROLE`);
        if (cfg.executor && !(await tl.hasRole(await tl.EXECUTOR_ROLE(), cfg.executor))) problems.push(`executor ${cfg.executor} lacks EXECUTOR_ROLE`);
      } catch (e) {
        problems.push(`live read failed: ${e.shortMessage || e.message}`);
      }
    }
    if (problems.length) {
      failed = true;
      for (const p of problems) console.log(`  [FAIL] ${p}`);
    } else {
      console.log(`  [OK] ${cfg.name} ready for plan`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function cmdPlan(config, keys) {
  for (const key of keys) {
    const cfg = config.chains[key];
    console.log(`\n=== plan ${cfg.name} ===`);
    const rec = loadOps(key);
    const impl = rec.implementation || cfg.implementation;
    const registry = rec.registry || cfg.registry;
    if (!impl) { console.log("  [SKIP] no implementation deployed (run deploy-impl)"); continue; }
    if (!registry) { console.log("  [SKIP] no registry deployed (run deploy-registry)"); continue; }

    const tokens = chainTokens(cfg, config);
    const charities = chainCharities(cfg, config);
    if (!tokens.length) console.log("  [WARN] token config is EMPTY — schedule will refuse");
    if (!charities.length) console.log("  [WARN] charity list is EMPTY — schedule will refuse (supply the vetted set)");

    const configs = tokens.map((t) => ({
      enabled: !!t.enabled,
      perTxCap: BigInt(t.perTxCapWei),
      dailyCap: BigInt(t.dailyCapWei),
      dailyWindowStart: 0n,
      dailyVolume: 0n,
    }));
    const tokenAddrs = tokens.map((t) => t.token);
    const ops = buildOps({ chain: key, proxy: cfg.proxy, registry, impl, tokens: tokenAddrs, configs, charities });
    console.log(`  impl       ${impl}`);
    console.log(`  registry   ${registry}`);
    for (const op of ops) {
      console.log(`  ${op.name}:`);
      console.log(`    target=${op.target}`);
      console.log(`    predecessor=${op.predecessor}`);
      console.log(`    salt=${op.salt}`);
      console.log(`    opId=${op.id}`);
      console.log(`    calldata=${op.data.slice(0, 66)}… (${(op.data.length - 2) / 2} bytes)`);
    }
    if (tokens.length) {
      console.log(`  token config (${tokenAddrs.length}):`);
      for (let i = 0; i < tokenAddrs.length; i++) console.log(`    ${tokenAddrs[i]}  enabled=${tokens[i].enabled} perTx=${configs[i].perTxCap} daily=${configs[i].dailyCap}`);
    }
    if (charities.length) console.log(`  charities (${charities.length}): ${charities.join(", ")}`);
  }
}

/** Resolve ops using the current config + ops record (used by status/plan/schedule/execute/verify). */
function buildOpsForChain(key, config = loadConfig()) {
  const cfg = config.chains[key];
  const rec = loadOps(key);
  const impl = rec.implementation || cfg.implementation;
  const registry = rec.registry || cfg.registry;
  if (!impl || !registry) return [];
  const tokens = chainTokens(cfg, config);
  const configs = tokens.map((t) => ({
    enabled: !!t.enabled,
    perTxCap: BigInt(t.perTxCapWei),
    dailyCap: BigInt(t.dailyCapWei),
    dailyWindowStart: 0n,
    dailyVolume: 0n,
  }));
  return buildOps({
    chain: key,
    proxy: cfg.proxy,
    registry,
    impl,
    tokens: tokens.map((t) => t.token),
    configs,
    charities: chainCharities(cfg, config),
  });
}

async function cmdDeployImpl(config, keys) {
  for (const key of keys) {
    const cfg = config.chains[key];
    console.log(`\n=== deploy-impl ${cfg.name} ===`);
    requireVerified(cfg);
    const provider = providerFor(cfg);
    const signer = signerFor(cfg, cfg.proposer || cfg.executor, "deployer").connect(provider);
    const bal = await provider.getBalance(signer.address);
    if (bal === 0n) throw new Error(`${cfg.name}: deployer ${signer.address} has zero balance`);
    const rec = loadOps(key);
    if (rec.implementation) { console.log(`  [SKIP] implementation already recorded: ${rec.implementation}`); continue; }
    const factory = new ethers.ContractFactory(
      ARTIFACTS.DurationDonation.abi,
      ARTIFACTS.DurationDonation.bytecode,
      signer,
    );
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    const addr = await impl.getAddress();
    rec.implementation = addr;
    rec.implementationBytecodeHash = ethers.keccak256(ARTIFACTS.DurationDonation.deployedBytecode);
    rec.deployedAt = new Date().toISOString();
    saveOps(key, rec);
    console.log(`  [OK] implementation deployed: ${addr}`);
    console.log(`       bytecode hash: ${rec.implementationBytecodeHash}`);
  }
}

async function cmdDeployRegistry(config, keys) {
  for (const key of keys) {
    const cfg = config.chains[key];
    console.log(`\n=== deploy-registry ${cfg.name} ===`);
    requireVerified(cfg);
    const provider = providerFor(cfg);
    const signer = signerFor(cfg, cfg.proposer || cfg.executor, "deployer").connect(provider);
    const rec = loadOps(key);
    if (rec.registry) { console.log(`  [SKIP] registry already recorded: ${rec.registry}`); continue; }
    const factory = new ethers.ContractFactory(
      ARTIFACTS.CharityRegistry.abi,
      ARTIFACTS.CharityRegistry.bytecode,
      signer,
    );
    const reg = await factory.deploy(cfg.timelock); // owner = 72h timelock
    await reg.waitForDeployment();
    const addr = await reg.getAddress();
    const onChainOwner = await reg.owner();
    if (onChainOwner.toLowerCase() !== cfg.timelock.toLowerCase()) {
      throw new Error(`${cfg.name}: registry owner ${onChainOwner} != timelock ${cfg.timelock} — aborting`);
    }
    rec.registry = addr;
    rec.registryDeployedAt = new Date().toISOString();
    saveOps(key, rec);
    console.log(`  [OK] CharityRegistry deployed: ${addr} (owner=${onChainOwner})`);
  }
}

async function cmdSchedule(config, keys) {
  for (const key of keys) {
    const cfg = config.chains[key];
    console.log(`\n=== schedule ${cfg.name} ===`);
    requireVerified(cfg);
    const tokens = chainTokens(cfg, config);
    const charities = chainCharities(cfg, config);
    if (!tokens.length) throw new Error(`${cfg.name}: token config is EMPTY — set it in upgrade-config.json first`);
    if (!charities.length) throw new Error(`${cfg.name}: charity list is EMPTY — set the vetted wallet set first`);
    const provider = providerFor(cfg);
    const signer = signerFor(cfg, cfg.proposer, "proposer").connect(provider);
    const tl = new ethers.Contract(cfg.timelock, ARTIFACTS.TimelockController.abi, signer);
    const dd = new ethers.Contract(cfg.proxy, ARTIFACTS.DurationDonation.abi, provider);

    const owner = await dd.owner();
    if (owner.toLowerCase() !== cfg.timelock.toLowerCase()) throw new Error(`${cfg.name}: proxy owner ${owner} != timelock — aborting`);
    const minDelay = await tl.getMinDelay();
    if (BigInt(minDelay) < MIN_DELAY) throw new Error(`${cfg.name}: unexpected minDelay ${minDelay}`);
    const proposerRole = await tl.PROPOSER_ROLE();
    if (!(await tl.hasRole(proposerRole, signer.address))) throw new Error(`${cfg.name}: signer ${signer.address} lacks PROPOSER_ROLE`);

    const ops = buildOpsForChain(key);
    if (!ops.length) throw new Error(`${cfg.name}: run deploy-impl and deploy-registry first`);
    const rec = loadOps(key);
    rec.scheduledAt = new Date().toISOString();
    for (const op of ops) {
      if (await tl.isOperationDone(op.id)) { console.log(`  ${op.name} already done — skip`); continue; }
      if (await tl.isOperationPending(op.id)) {
        const eta = new Date(Number((await tl.getTimestamp(op.id)) * 1000n)).toISOString();
        console.log(`  ${op.name} already pending (eta ${eta}) — skip`);
        continue;
      }
      const tx = await tl.schedule(op.target, op.value, op.data, op.predecessor, op.salt, minDelay);
      const rc = await tx.wait();
      const eta = new Date(Number((await tl.getTimestamp(op.id)) * 1000n)).toISOString();
      rec.ops[op.name] = { opId: op.id, txHash: rc.hash, eta, blockNumber: rc.blockNumber };
      console.log(`  ${op.name} scheduled  opId=${op.id}  tx=${rc.hash}  eta=${eta}`);
      saveOps(key, rec);
    }
    console.log("  SCHEDULE_COMPLETE");
  }
}

async function cmdExecute(config, keys) {
  for (const key of keys) {
    const cfg = config.chains[key];
    console.log(`\n=== execute ${cfg.name} ===`);
    requireVerified(cfg);
    const provider = providerFor(cfg);
    const signer = signerFor(cfg, cfg.executor || cfg.proposer, "executor").connect(provider);
    const tl = new ethers.Contract(cfg.timelock, ARTIFACTS.TimelockController.abi, signer);
    const executorRole = await tl.EXECUTOR_ROLE();
    if (!(await tl.hasRole(executorRole, signer.address))) throw new Error(`${cfg.name}: signer ${signer.address} lacks EXECUTOR_ROLE`);

    const ops = buildOpsForChain(key);
    if (!ops.length) throw new Error(`${cfg.name}: run deploy-impl and deploy-registry first`);
    const rec = loadOps(key);
    for (const op of ops) {
      const known = (await tl.isOperationPending(op.id)) || (await tl.isOperationDone(op.id));
      if (!known) {
        const recorded = (rec.ops && rec.ops[op.name]) || {};
        if (recorded.cancelledTxHash || recorded.cancelledBlock) {
          console.log(`  ${op.name} cancelled on-chain (tx ${recorded.cancelledTxHash || recorded.cancelledBlock}) — skip`);
          continue;
        }
        throw new Error(`${op.name}: op ${op.id} not known to timelock — run schedule first`);
      }
      if (await tl.isOperationDone(op.id)) { console.log(`  ${op.name} already executed — skip`); continue; }
      if (!(await tl.isOperationReady(op.id))) {
        const eta = new Date(Number((await tl.getTimestamp(op.id)) * 1000n)).toISOString();
        console.log(`  ${op.name} not ready (eta ${eta}) — later ops are chained; stopping here`);
        return;
      }
      const tx = await tl.execute(op.target, op.value, op.data, op.predecessor, op.salt);
      const rc = await tx.wait();
      rec.ops[op.name] = rec.ops[op.name] || {};
      rec.ops[op.name].executedTxHash = rc.hash;
      rec.ops[op.name].executedBlock = rc.blockNumber;
      console.log(`  ${op.name} executed  tx=${rc.hash}`);
      saveOps(key, rec);
    }
    console.log("  EXECUTE_COMPLETE");
  }
}

async function cmdVerify(config, keys) {
  for (const key of keys) {
    const cfg = config.chains[key];
    console.log(`\n=== verify ${cfg.name} ===`);
    const provider = providerFor(cfg);
    const dd = new ethers.Contract(cfg.proxy, ARTIFACTS.DurationDonation.abi, provider);
    const rec = loadOps(key);
    const impl = rec.implementation || cfg.implementation;
    const registry = rec.registry || cfg.registry;
    let ok = true;
    const check = (label, pass, detail) => {
      console.log(`  ${pass ? "[OK]" : "[FAIL]"} ${label}${detail ? ` — ${detail}` : ""}`);
      if (!pass) ok = false;
    };

    const onChainImpl = await readImplSlot(provider, cfg.proxy);
    check("impl slot == deployed impl", onChainImpl && impl && onChainImpl.toLowerCase() === impl.toLowerCase(), `slot=${onChainImpl} expected=${impl}`);

    let reg = null;
    try {
      reg = await dd.charityRegistry();
      check("charityRegistry wired", reg !== ethers.ZeroAddress, reg);
    } catch (e) {
      check("charityRegistry wired", false, "function absent (upgrade not applied?)");
    }
    if (reg && registry) check("charityRegistry == deployed registry", reg.toLowerCase() === registry.toLowerCase(), reg);

    // Token config: every configured token must match on-chain; unlisted tokens
    // must stay denied (deny-by-default).
    const tokens = chainTokens(cfg, config);
    let nativeExpectEnabled = false;
    try {
      for (const t of tokens) {
        const onChain = await dd.tokenConfigs(t.token);
        const wantEnabled = !!t.enabled;
        if (t.token.toLowerCase() === ethers.ZeroAddress.toLowerCase()) nativeExpectEnabled = wantEnabled;
        const match =
          onChain.enabled === wantEnabled &&
          (!wantEnabled ||
            (onChain.perTxCap === BigInt(t.perTxCapWei) && onChain.dailyCap === BigInt(t.dailyCapWei)));
        check(
          `tokenConfigs(${t.symbol || t.token})`,
          match,
          `enabled=${onChain.enabled}/${wantEnabled} perTx=${onChain.perTxCap}/${t.perTxCapWei} daily=${onChain.dailyCap}/${t.dailyCapWei}`,
        );
      }
      const unconfigured = ethers.Wallet.createRandom().address;
      check("deny-by-default (unlisted token disabled)", (await dd.tokenConfigs(unconfigured)).enabled === false);
    } catch (e) {
      check("tokenConfigs readable", false, e.shortMessage || e.message);
    }

    // Donation simulation: prove the allowlist gate behaves as configured.
    const charities = chainCharities(cfg, config);
    if (charities.length && reg && reg !== ethers.ZeroAddress) {
      try {
        const cr = new ethers.Contract(reg, ARTIFACTS.CharityRegistry.abi, provider);
        const info = await cr.getCharityInfo(charities[0]);
        check("first charity registered+active", info.isRegistered_ && info.isActive_, charities[0]);
        const data = dd.interface.encodeFunctionData("donateNative", [charities[0], 0n]);
        try {
          await provider.call({ from: cfg.proposer || ethers.ZeroAddress, to: cfg.proxy, data, value: DONATION_SIMULATION_WEI });
          check(
            "native donation simulation",
            nativeExpectEnabled,
            nativeExpectEnabled ? "succeeded" : "unexpectedly succeeded while native is not allowlisted",
          );
        } catch (e) {
          if (nativeExpectEnabled) check("native donation simulation", false, e.shortMessage || e.message);
          else check("native donation blocked by allowlist (expected)", true, e.shortMessage || "reverted");
        }
      } catch (e) {
        check("donation simulation", false, e.shortMessage || e.message);
      }
    } else {
      console.log("  [SKIP] donation simulation — no charity list recorded");
    }

    console.log(ok ? "  VERIFY_COMPLETE" : "  VERIFY_FAILED");
    if (!ok) process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv;
  const command = argv[2] || "status";
  const config = loadConfig();
  const keys = chainArg(config, argv);

  switch (command) {
    case "status": return cmdStatus(config, keys);
    case "validate": return cmdValidate(config, keys);
    case "plan": return cmdPlan(config, keys);
    case "deploy-impl": return cmdDeployImpl(config, keys);
    case "deploy-registry": return cmdDeployRegistry(config, keys);
    case "schedule": return cmdSchedule(config, keys);
    case "execute": return cmdExecute(config, keys);
    case "verify": return cmdVerify(config, keys);
    default: throw new Error(`Unknown command: ${command}`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("FAILED:", e.shortMessage || e.message);
      process.exit(1);
    });
}

module.exports = {
  opId,
  buildInitializeV2Data,
  buildUpgradeData,
  buildSetRegistryData,
  buildRegisterData,
  buildOps,
  loadConfig,
};
