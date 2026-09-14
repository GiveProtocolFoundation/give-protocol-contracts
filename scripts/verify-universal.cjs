/**
 * Universal contract verification script (Etherscan V2 unified API).
 * Reads the latest deployment artifacts and verifies every contract +
 * proxy implementation on the target network's explorer.
 *
 * Usage:
 *   ETHERSCAN_API_KEY=xxx npx hardhat run scripts/verify-universal.cjs --network baseSepolia
 *   (or: npm run verify:base-sepolia once the key is in .env)
 */
const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");

// Constructor args for non-proxy contracts (must match deploy-universal.cjs)
function flatConstructorArgs(deployment) {
  const multiSig = deployment.multiSig || process.env.MULTISIG_ADDRESS || "0x0000000000000000000000000000000000000000";
  return {
    MockERC20: ["Give Test Token", "GIVE"],
    DistributionExecutor: [deployment.contracts?.CharityScheduledDistribution?.proxy],
    fundHolding72h: [259200, [multiSig], [multiSig], hre.ethers.ZeroAddress],
    recordKeeping24h: [86400, [multiSig], [multiSig], hre.ethers.ZeroAddress],
  };
}

/**
 * Load the deployment file for the current network and verify every contract in it.
 * @returns {Promise<void>}
 */
async function main() {
  const networkName = hre.network.name;
  const deployFile = path.join(DEPLOYMENTS_DIR, `${networkName}.json`);

  if (!fs.existsSync(deployFile)) {
    throw new Error(`No deployment file found: ${deployFile}. Deploy first.`);
  }

  const deployment = JSON.parse(fs.readFileSync(deployFile, "utf8"));
  console.log(`\nVerifying deployment: ${deployFile}\n${"=".repeat(60)}\n`);

  const CONSTRUCTOR_ARGS = flatConstructorArgs(deployment);
  const results = { verified: [], skipped: [], failed: [] };

  for (const [name, info] of Object.entries(deployment.contracts || {})) {
    // 1. Verify proxy (cheap — proxies share the same bytecode, usually instant)
    if (info.proxy) {
      await verify(name, info.proxy, [], results);
    }
    // 2. Verify implementation (needs constructor args if not a proxy target)
    if (info.implementation) {
      await verify(
        `${name} (implementation)`,
        info.implementation,
        [],
        results,
      );
    }
    // 3. Verify non-proxy contracts
    if (info.address && !info.proxy) {
      const args = CONSTRUCTOR_ARGS[name] || [];
      await verify(name, info.address, args, results);
    }
  }

  // Timelocks
  for (const [name, address] of Object.entries(deployment.timelocks || {})) {
    await verify(name, address, CONSTRUCTOR_ARGS[name] || [], results);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("VERIFICATION SUMMARY");
  console.log(`${"=".repeat(60)}`);
  console.log(`Verified: ${results.verified.length}`);
  console.log(`Skipped:  ${results.skipped.length}`);
  console.log(`Failed:   ${results.failed.length}`);
  if (results.failed.length) {
    console.log("\nFailed items:");
    results.failed.forEach((f) => console.log(`  - ${f.name}: ${f.reason}`));
  }
}

let lastCall = 0;
/**
 * Throttle explorer calls to stay within the free-tier rate limit.
 * @returns {Promise<void>}
 */
async function pace() {
  const gap = 2500; // stay under Etherscan's 3 calls/sec free-tier limit
  const wait = lastCall + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

/**
 * Verify one contract, recording the outcome in `results`.
 * @param {string} name - Human-readable label for logs/summary.
 * @param {string} address - Contract address to verify.
 * @param {Array} constructorArgs - Constructor arguments (empty for proxies/implementations).
 * @param {{verified: string[], skipped: string[], failed: {name: string, reason: string}[]}} results - Collector for outcomes.
 * @returns {Promise<void>}
 */
async function verify(name, address, constructorArgs, results) {
  process.stdout.write(`Verifying ${name} at ${address}... `);
  await pace();
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log("[OK]");
    results.verified.push(name);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes("Already Verified") || msg.includes("already verified")) {
      console.log("[ALREADY VERIFIED]");
      results.verified.push(name);
    } else if (msg.includes("Missing or invalid Api Key") || msg.includes("no API token")) {
      console.log("[SKIPPED — no API key]");
      console.log("  Set ETHERSCAN_API_KEY in .env (one key covers all chains via Etherscan V2)");
      results.skipped.push(name);
    } else {
      console.log("[FAILED]");
      console.log(`  ${msg.slice(0, 200)}`);
      results.failed.push({ name, reason: msg.slice(0, 200) });
    }
  }
}

main().catch((err) => {
  console.error(err);
  // Set exitCode instead of process.exit() so pending I/O can flush.
  process.exitCode = 1;
});
