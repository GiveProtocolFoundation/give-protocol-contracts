const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Chain-specific configuration for deployment
 */
const CHAIN_CONFIG = {
  // Testnets
  baseSepolia: {
    name: "Base Sepolia",
    treasuryEnvKey: "BASE_TREASURY_ADDRESS",
    explorerName: "Basescan",
    nativeSymbol: "ETH",
    isTestnet: true,
  },
  optimismSepolia: {
    name: "Optimism Sepolia",
    treasuryEnvKey: "OPTIMISM_TREASURY_ADDRESS",
    explorerName: "Optimism Etherscan",
    nativeSymbol: "ETH",
    isTestnet: true,
  },
  moonbase: {
    name: "Moonbase Alpha",
    treasuryEnvKey: "MOONBEAM_TREASURY_ADDRESS",
    explorerName: "Moonscan",
    nativeSymbol: "DEV",
    isTestnet: true,
  },
  // Mainnets
  base: {
    name: "Base",
    treasuryEnvKey: "BASE_TREASURY_ADDRESS",
    explorerName: "Basescan",
    nativeSymbol: "ETH",
    isTestnet: false,
  },
  optimism: {
    name: "Optimism",
    treasuryEnvKey: "OPTIMISM_TREASURY_ADDRESS",
    explorerName: "Optimism Etherscan",
    nativeSymbol: "ETH",
    isTestnet: false,
  },
  moonbeam: {
    name: "Moonbeam",
    treasuryEnvKey: "MOONBEAM_TREASURY_ADDRESS",
    explorerName: "Moonscan",
    nativeSymbol: "GLMR",
    isTestnet: false,
  },
  ethereum: {
    name: "Ethereum",
    treasuryEnvKey: "ETHEREUM_TREASURY_ADDRESS",
    explorerName: "Etherscan",
    nativeSymbol: "ETH",
    isTestnet: false,
  },
  arbitrum: {
    name: "Arbitrum One",
    treasuryEnvKey: "ARBITRUM_TREASURY_ADDRESS",
    explorerName: "Arbiscan",
    nativeSymbol: "ETH",
    isTestnet: false,
  },
  polygon: {
    name: "Polygon PoS",
    treasuryEnvKey: "POLYGON_TREASURY_ADDRESS",
    explorerName: "Polygonscan",
    nativeSymbol: "POL",
    isTestnet: false,
  },
  avalanche: {
    name: "Avalanche C-Chain",
    treasuryEnvKey: "AVALANCHE_TREASURY_ADDRESS",
    explorerName: "Snowtrace",
    nativeSymbol: "AVAX",
    isTestnet: false,
  },
};

// Timelock delays
const FUND_HOLDING_DELAY = 72 * 60 * 60; // 72 hours
const RECORD_KEEPING_DELAY = 24 * 60 * 60; // 24 hours

/**
 * Retry helper: public RPCs sometimes return stale storage reads right after a deploy.
 * @param {string} proxyAddress - Address of the deployed proxy.
 * @param {number} [attempts=5] - Maximum number of read attempts.
 * @param {number} [delayMs=4000] - Delay between attempts in milliseconds.
 * @returns {Promise<string>} The EIP-1967 implementation address.
 */
async function getImplWithRetry(proxyAddress, attempts = 5, delayMs = 4000) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        console.log(`     [RETRY ${i + 1}/${attempts}] RPC read failed (${err.message.slice(0, 80)}), retrying in ${delayMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Send a role-management transaction with an explicit pending nonce,
 * EIP-1559 pricing, and idempotent state checks.
 *
 * Public RPCs sometimes drop the HTTP response after already accepting a
 * transaction; the automatic resend then double-broadcasts the same nonce and
 * the node rejects it ("replacement transaction underpriced"), which aborted
 * both the Polygon and Avalanche deploys mid-run (GIV-774). An explicit nonce
 * eliminates the race; `checkDone` skips re-sends when a prior attempt
 * actually landed, making the whole role section safe to re-run.
 * @param {Function} sendFn - Receives tx overrides; returns the sent tx.
 * @param {Function} [checkDone] - Async predicate: true when the desired
 *   role state is already on-chain.
 * @returns {Promise<void>}
 */
async function sendRoleTx(sendFn, checkDone) {
  const [deployer] = await hre.ethers.getSigners();
  let priorityFee = 1000000000n;
  let base = 100000000000n;
  try {
    const fee = await hre.ethers.provider.getFeeData();
    if (fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n) {
      priorityFee = fee.maxPriorityFeePerGas;
    }
    base = fee.maxFeePerGas && fee.maxFeePerGas > 0n ? fee.maxFeePerGas : fee.gasPrice || 100000000000n;
  } catch (err) {
    console.log(`     [WARN] fee data fetch failed (${err.message.slice(0, 60)}) — using defaults`);
  }
  // Polygon public nodes routinely demand priority fees above reported values.
  if ((await hre.ethers.provider.getNetwork()).chainId === 137n && priorityFee < 30000000000n) {
    priorityFee = 30000000000n;
  }
  // Recomputed on every priorityFee change so maxFeePerGas always stays
  // above maxPriorityFeePerGas (an EIP-1559 tx is invalid otherwise).
  let maxFee = base * 2n + priorityFee;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (checkDone && (await checkDone())) {
      console.log("     [OK] desired role state already on-chain");
      return;
    }
    const nonce = await hre.ethers.provider.getTransactionCount(deployer.address, "pending");
    try {
      const tx = await sendFn({ nonce, maxPriorityFeePerGas: priorityFee, maxFeePerGas: maxFee });
      await tx.wait();
      return;
    } catch (err) {
      const msg = err.message || "";
      if ((msg.includes("underpriced") || msg.includes("nonce too low")) && attempt < 4) {
        console.log(`     [RETRY ${attempt}/4] tx rejected (${msg.slice(0, 60)}) — re-checking state, bumping fees...`);
        await new Promise((r) => setTimeout(r, 5000));
        priorityFee = (priorityFee * 125n) / 100n;
        maxFee = base * 2n + priorityFee;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Verify a deployed contract on the block explorer, tolerating "already verified".
 * @param {string} address - Deployed contract address to verify.
 * @param {Array} [constructorArguments=[]] - Constructor arguments used at deploy time.
 * @returns {Promise<void>}
 */
async function verifyContract(address, constructorArguments = []) {
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
    });
    console.log(`[OK] Contract verified at ${address}`);
  } catch (error) {
    if (error.message.includes("already verified")) {
      console.log(`[OK] Contract already verified at ${address}`);
    } else {
      console.log(`[WARN] Verification failed: ${error.message}`);
    }
  }
}

/**
 * Universal deployment function for all supported networks
 * @returns {Promise<void>}
 */
async function main() {
  const networkName = hre.network.name;
  const chainConfig = CHAIN_CONFIG[networkName];

  if (!chainConfig) {
    throw new Error(
      `Unsupported network: ${networkName}. Supported: ${Object.keys(CHAIN_CONFIG).join(", ")}`,
    );
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deploying to ${chainConfig.name}`);
  console.log(`${"=".repeat(60)}\n`);

  // Get deployer
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // Check balance
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log(
    `Balance: ${hre.ethers.formatEther(balance)} ${chainConfig.nativeSymbol}`,
  );

  if (balance === 0n) {
    throw new Error(
      `Deployer has no ${chainConfig.nativeSymbol}. Fund the account first.`,
    );
  }

  // Get treasury / multi-sig address
  const treasuryAddress =
    process.env[chainConfig.treasuryEnvKey] || deployer.address;
  console.log(`Treasury: ${treasuryAddress}`);

  if (treasuryAddress === deployer.address) {
    console.log(
      "[WARN] Using deployer as treasury - update this for production!",
    );
  }

  // Multi-sig address for timelock proposer/executor (defaults to deployer for testnets)
  const multiSigAddress = process.env.MULTISIG_ADDRESS || deployer.address;
  console.log(`Multi-sig: ${multiSigAddress}`);

  const contracts = {};
  const timelocks = {};

  // 1. Deploy MockERC20 (testnet only)
  if (chainConfig.isTestnet) {
    console.log("\n[1/9] Deploying MockERC20...");
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    const mockToken = await MockERC20.deploy("Give Test Token", "GIVE");
    await mockToken.waitForDeployment();
    contracts.MockERC20 = { address: await mockToken.getAddress() };
    console.log(`[OK] MockERC20: ${contracts.MockERC20.address}`);
  } else {
    console.log("\n[1/9] Skipping MockERC20 (mainnet deployment)");
  }

  // 2. Deploy TimelockController — 72h (fund-holding contracts)
  console.log(`\n[2/9] Deploying TimelockController (${FUND_HOLDING_DELAY / 3600}h — fund-holding)...`);
  const TimelockController = await hre.ethers.getContractFactory("TimelockController");
  const timelock72h = await TimelockController.deploy(
    FUND_HOLDING_DELAY,
    [multiSigAddress], // proposers
    [multiSigAddress], // executors
    hre.ethers.ZeroAddress, // admin = address(0) → self-governing
  );
  await timelock72h.waitForDeployment();
  timelocks.fundHolding72h = await timelock72h.getAddress();
  console.log(`[OK] TimelockController (72h): ${timelocks.fundHolding72h}`);

  // 3. Deploy TimelockController — 24h (record-keeping contracts)
  console.log(`\n[3/9] Deploying TimelockController (${RECORD_KEEPING_DELAY / 3600}h — record-keeping)...`);
  const timelock24h = await TimelockController.deploy(
    RECORD_KEEPING_DELAY,
    [multiSigAddress], // proposers
    [multiSigAddress], // executors
    hre.ethers.ZeroAddress,
  );
  await timelock24h.waitForDeployment();
  timelocks.recordKeeping24h = await timelock24h.getAddress();
  console.log(`[OK] TimelockController (24h): ${timelocks.recordKeeping24h}`);

  // 4. Deploy DurationDonation proxy (fund-holding → 72h timelock as owner)
  console.log("\n[4/9] Deploying DurationDonation (UUPS proxy)...");
  const DurationDonation = await hre.ethers.getContractFactory("DurationDonation");
  const donation = await hre.upgrades.deployProxy(
    DurationDonation,
    [treasuryAddress, timelocks.fundHolding72h],
    { initializer: "initialize", kind: "uups" },
  );
  await donation.waitForDeployment();
  const donationProxy = await donation.getAddress();
  const donationImpl = await getImplWithRetry(donationProxy);
  contracts.DurationDonation = { proxy: donationProxy, implementation: donationImpl };
  console.log(`[OK] DurationDonation proxy: ${donationProxy}`);
  console.log(`     Implementation: ${donationImpl}`);

  // 5. Deploy PortfolioFunds proxy (fund-holding → 72h timelock as admin)
  console.log("\n[5/9] Deploying PortfolioFunds (UUPS proxy)...");
  const PortfolioFunds = await hre.ethers.getContractFactory("PortfolioFunds");
  const portfolio = await hre.upgrades.deployProxy(
    PortfolioFunds,
    [treasuryAddress, deployer.address], // deployer as initial admin to configure roles
    { initializer: "initialize", kind: "uups" },
  );
  await portfolio.waitForDeployment();
  const portfolioProxy = await portfolio.getAddress();
  const portfolioImpl = await getImplWithRetry(portfolioProxy);
  contracts.PortfolioFunds = { proxy: portfolioProxy, implementation: portfolioImpl };
  console.log(`[OK] PortfolioFunds proxy: ${portfolioProxy}`);
  console.log(`     Implementation: ${portfolioImpl}`);

  // Grant DEFAULT_ADMIN_ROLE to 72h timelock, then revoke from deployer
  const DEFAULT_ADMIN_ROLE = await portfolio.DEFAULT_ADMIN_ROLE();
  const ADMIN_ROLE = await portfolio.ADMIN_ROLE();
  const GOVERNANCE_ROLE = await portfolio.GOVERNANCE_ROLE();

  console.log("     Transferring admin roles to timelock...");
  await sendRoleTx(
    (o) => portfolio.grantRole(DEFAULT_ADMIN_ROLE, timelocks.fundHolding72h, o),
    () => portfolio.hasRole(DEFAULT_ADMIN_ROLE, timelocks.fundHolding72h),
  );
  await sendRoleTx(
    (o) => portfolio.grantRole(ADMIN_ROLE, timelocks.fundHolding72h, o),
    () => portfolio.hasRole(ADMIN_ROLE, timelocks.fundHolding72h),
  );
  await sendRoleTx(
    (o) => portfolio.grantRole(GOVERNANCE_ROLE, timelocks.fundHolding72h, o),
    () => portfolio.hasRole(GOVERNANCE_ROLE, timelocks.fundHolding72h),
  );
  await sendRoleTx(
    (o) => portfolio.revokeRole(GOVERNANCE_ROLE, deployer.address, o),
    async () => !(await portfolio.hasRole(GOVERNANCE_ROLE, deployer.address)),
  );
  await sendRoleTx(
    (o) => portfolio.revokeRole(ADMIN_ROLE, deployer.address, o),
    async () => !(await portfolio.hasRole(ADMIN_ROLE, deployer.address)),
  );
  await sendRoleTx(
    (o) => portfolio.revokeRole(DEFAULT_ADMIN_ROLE, deployer.address, o),
    async () => !(await portfolio.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)),
  );
  console.log("     [OK] Roles transferred to timelock");

  // 6. Deploy CharityScheduledDistribution proxy (fund-holding → 72h timelock as owner)
  console.log("\n[6/9] Deploying CharityScheduledDistribution (UUPS proxy)...");
  const CharityScheduledDistribution = await hre.ethers.getContractFactory("CharityScheduledDistribution");
  const distribution = await hre.upgrades.deployProxy(
    CharityScheduledDistribution,
    [treasuryAddress, timelocks.fundHolding72h],
    { initializer: "initialize", kind: "uups" },
  );
  await distribution.waitForDeployment();
  const distributionProxy = await distribution.getAddress();
  const distributionImpl = await getImplWithRetry(distributionProxy);
  contracts.CharityScheduledDistribution = { proxy: distributionProxy, implementation: distributionImpl };
  console.log(`[OK] CharityScheduledDistribution proxy: ${distributionProxy}`);
  console.log(`     Implementation: ${distributionImpl}`);

  // 7. Deploy VolunteerVerification proxy (record-keeping → 24h timelock as owner)
  console.log("\n[7/9] Deploying VolunteerVerification (UUPS proxy)...");
  const VolunteerVerification = await hre.ethers.getContractFactory("VolunteerVerification");
  const verification = await hre.upgrades.deployProxy(
    VolunteerVerification,
    [timelocks.recordKeeping24h],
    { initializer: "initialize", kind: "uups" },
  );
  await verification.waitForDeployment();
  const verificationProxy = await verification.getAddress();
  const verificationImpl = await getImplWithRetry(verificationProxy);
  contracts.VolunteerVerification = { proxy: verificationProxy, implementation: verificationImpl };
  console.log(`[OK] VolunteerVerification proxy: ${verificationProxy}`);
  console.log(`     Implementation: ${verificationImpl}`);

  // 8. Deploy DistributionExecutor (not upgradeable — takes proxy address)
  console.log("\n[8/9] Deploying DistributionExecutor...");
  const DistributionExecutor = await hre.ethers.getContractFactory("DistributionExecutor");
  const executor = await DistributionExecutor.deploy(distributionProxy);
  await executor.waitForDeployment();
  contracts.DistributionExecutor = { address: await executor.getAddress() };
  console.log(`[OK] DistributionExecutor: ${contracts.DistributionExecutor.address}`);

  // 9. Deploy FiatDonationAttestation proxy (record-keeping → 24h timelock as admin)
  console.log("\n[9/9] Deploying FiatDonationAttestation (UUPS proxy)...");
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const FiatDonationAttestation = await hre.ethers.getContractFactory("FiatDonationAttestation");
  const fiatAttestation = await hre.upgrades.deployProxy(
    FiatDonationAttestation,
    [Number(chainId), deployer.address], // deployer as initial admin to configure roles
    { initializer: "initialize", kind: "uups" },
  );
  await fiatAttestation.waitForDeployment();
  const fiatAttestationProxy = await fiatAttestation.getAddress();
  const fiatAttestationImpl = await getImplWithRetry(fiatAttestationProxy);
  contracts.FiatDonationAttestation = { proxy: fiatAttestationProxy, implementation: fiatAttestationImpl };
  console.log(`[OK] FiatDonationAttestation proxy: ${fiatAttestationProxy}`);
  console.log(`     Implementation: ${fiatAttestationImpl}`);

  // Role constants computed locally: RPC static reads against a
  // just-deployed proxy returned empty data on Polygon (GIV-774).
  const FDA_DEFAULT_ADMIN_ROLE = hre.ethers.ZeroHash; // OZ: bytes32(0)
  const FDA_ADMIN_ROLE = hre.ethers.id("ADMIN_ROLE");
  const FDA_ATTESTER_ROLE = hre.ethers.id("ATTESTER_ROLE");

  // Grant ATTESTER_ROLE to bridge wallet (defaults to deployer for testnets)
  const attesterAddress = process.env.ATTESTER_ADDRESS || deployer.address;
  console.log(`     Attester (bridge wallet): ${attesterAddress}`);
  await sendRoleTx(
    (o) => fiatAttestation.grantRole(FDA_ATTESTER_ROLE, attesterAddress, o),
    () => fiatAttestation.hasRole(FDA_ATTESTER_ROLE, attesterAddress),
  );

  console.log("     Transferring admin roles to timelock...");
  await sendRoleTx(
    (o) => fiatAttestation.grantRole(FDA_DEFAULT_ADMIN_ROLE, timelocks.recordKeeping24h, o),
    () => fiatAttestation.hasRole(FDA_DEFAULT_ADMIN_ROLE, timelocks.recordKeeping24h),
  );
  await sendRoleTx(
    (o) => fiatAttestation.grantRole(FDA_ADMIN_ROLE, timelocks.recordKeeping24h, o),
    () => fiatAttestation.hasRole(FDA_ADMIN_ROLE, timelocks.recordKeeping24h),
  );
  await sendRoleTx(
    (o) => fiatAttestation.revokeRole(FDA_ADMIN_ROLE, deployer.address, o),
    async () => !(await fiatAttestation.hasRole(FDA_ADMIN_ROLE, deployer.address)),
  );
  await sendRoleTx(
    (o) => fiatAttestation.revokeRole(FDA_DEFAULT_ADMIN_ROLE, deployer.address, o),
    async () => !(await fiatAttestation.hasRole(FDA_DEFAULT_ADMIN_ROLE, deployer.address)),
  );
  console.log("     [OK] Roles transferred to timelock");

  // Save deployment info
  const deploymentInfo = {
    network: networkName,
    chainId: Number(chainId),
    deployer: deployer.address,
    treasury: treasuryAddress,
    multiSig: multiSigAddress,
    timestamp: new Date().toISOString(),
    contracts,
    timelocks,
  };

  const deploymentPath = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentPath)) {
    fs.mkdirSync(deploymentPath, { recursive: true });
  }

  const deploymentFile = path.join(deploymentPath, `${networkName}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\n[OK] Deployment saved to: ${deploymentFile}`);

  // Update master addresses file
  const masterFile = path.join(deploymentPath, "addresses.json");
  let masterAddresses = {};
  if (fs.existsSync(masterFile)) {
    masterAddresses = JSON.parse(fs.readFileSync(masterFile, "utf8"));
  }
  masterAddresses[networkName] = deploymentInfo;
  fs.writeFileSync(masterFile, JSON.stringify(masterAddresses, null, 2));
  console.log(`[OK] Master addresses updated: ${masterFile}`);

  // Print summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("DEPLOYMENT COMPLETE");
  console.log(`${"=".repeat(60)}`);
  console.log("\nContract Addresses (proxy where applicable):");
  for (const [name, info] of Object.entries(contracts)) {
    const addr = info.proxy || info.address;
    console.log(`  ${name}: ${addr}`);
    if (info.implementation) {
      console.log(`    impl: ${info.implementation}`);
    }
  }
  console.log("\nTimelock Addresses:");
  console.log(`  Fund-holding (72h): ${timelocks.fundHolding72h}`);
  console.log(`  Record-keeping (24h): ${timelocks.recordKeeping24h}`);

  // Print environment variables for webapp (always use proxy address)
  const envPrefix = networkName.toUpperCase().replace("SEPOLIA", "_SEPOLIA");
  console.log("\nEnvironment Variables for Webapp:");
  if (contracts.MockERC20) {
    console.log(`VITE_${envPrefix}_TOKEN_ADDRESS=${contracts.MockERC20.address}`);
  }
  console.log(`VITE_${envPrefix}_DONATION_ADDRESS=${contracts.DurationDonation.proxy}`);
  console.log(`VITE_${envPrefix}_PORTFOLIO_ADDRESS=${contracts.PortfolioFunds.proxy}`);
  console.log(`VITE_${envPrefix}_VERIFICATION_ADDRESS=${contracts.VolunteerVerification.proxy}`);
  console.log(`VITE_${envPrefix}_DISTRIBUTION_ADDRESS=${contracts.CharityScheduledDistribution.proxy}`);
  console.log(`VITE_${envPrefix}_EXECUTOR_ADDRESS=${contracts.DistributionExecutor.address}`);
  console.log(`VITE_${envPrefix}_FIAT_ATTESTATION_ADDRESS=${contracts.FiatDonationAttestation.proxy}`);

  // Verify contracts if API key available
  // ETHERSCAN_API_KEY is the Etherscan V2 unified key that covers
  // Ethereum, Arbitrum, Polygon, and Avalanche via the chainid param.
  const hasApiKey =
    process.env.ETHERSCAN_API_KEY ||
    process.env.BASESCAN_API_KEY ||
    process.env.OPTIMISM_ETHERSCAN_API_KEY ||
    process.env.MOONSCAN_API_KEY;

  if (hasApiKey && networkName !== "hardhat") {
    console.log(
      `\n[INFO] Waiting 30s for ${chainConfig.explorerName} to index contracts...`,
    );
    await new Promise((r) => setTimeout(r, 30000));

    console.log("\nVerifying contracts...");

    if (contracts.MockERC20) {
      await verifyContract(contracts.MockERC20.address, ["Give Test Token", "GIVE"]);
    }
    // Verify timelock controllers
    await verifyContract(timelocks.fundHolding72h, [
      FUND_HOLDING_DELAY,
      [multiSigAddress],
      [multiSigAddress],
      hre.ethers.ZeroAddress,
    ]);
    await verifyContract(timelocks.recordKeeping24h, [
      RECORD_KEEPING_DELAY,
      [multiSigAddress],
      [multiSigAddress],
      hre.ethers.ZeroAddress,
    ]);
    // Verify implementation contracts
    await verifyContract(contracts.DurationDonation.implementation, []);
    await verifyContract(contracts.PortfolioFunds.implementation, []);
    await verifyContract(contracts.CharityScheduledDistribution.implementation, []);
    await verifyContract(contracts.VolunteerVerification.implementation, []);
    await verifyContract(contracts.FiatDonationAttestation.implementation, []);
    // Verify DistributionExecutor
    await verifyContract(contracts.DistributionExecutor.address, [distributionProxy]);
  }
}

main().catch((error) => {
  console.error("\n[ERROR]", error);
  process.exitCode = 1;
});
