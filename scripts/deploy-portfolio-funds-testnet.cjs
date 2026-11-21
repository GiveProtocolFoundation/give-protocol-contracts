const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Test charity wallet addresses for Moonbase Alpha.
 * In production these would be real charity multisig wallets.
 * For testnet user-testing, these are deterministic addresses
 * derived from the deployer so you can verify fund flows.
 */
const TEST_CHARITIES = {
  // Environmental
  oceanCleanup: "0x1111111111111111111111111111111111111001",
  rainforestAlliance: "0x1111111111111111111111111111111111111002",
  solarSister: "0x1111111111111111111111111111111111111003",
  treesForFuture: "0x1111111111111111111111111111111111111004",
  // Poverty relief
  giveDirectly: "0x1111111111111111111111111111111111111005",
  grameenFoundation: "0x1111111111111111111111111111111111111006",
  oxfamInternational: "0x1111111111111111111111111111111111111007",
  heiferInternational: "0x1111111111111111111111111111111111111008",
  // Education
  roomToRead: "0x1111111111111111111111111111111111111009",
  teachForAll: "0x1111111111111111111111111111111111111010",
  khanAcademy: "0x1111111111111111111111111111111111111011",
  girlsWhoCode: "0x1111111111111111111111111111111111111012",
};

/**
 * Registers test charity addresses as verified on the PortfolioFunds contract.
 * @param {object} contract - The PortfolioFunds contract instance
 */
async function setupVerifiedCharities(contract) {
  const charities = [
    { address: TEST_CHARITIES.oceanCleanup, name: "Ocean Cleanup Foundation" },
    { address: TEST_CHARITIES.rainforestAlliance, name: "Rainforest Alliance" },
    { address: TEST_CHARITIES.solarSister, name: "Solar Sister" },
    { address: TEST_CHARITIES.treesForFuture, name: "Trees for the Future" },
    { address: TEST_CHARITIES.giveDirectly, name: "GiveDirectly" },
    { address: TEST_CHARITIES.grameenFoundation, name: "Grameen Foundation" },
    { address: TEST_CHARITIES.oxfamInternational, name: "Oxfam International" },
    { address: TEST_CHARITIES.heiferInternational, name: "Heifer International" },
    { address: TEST_CHARITIES.roomToRead, name: "Room to Read" },
    { address: TEST_CHARITIES.teachForAll, name: "Teach for All" },
    { address: TEST_CHARITIES.khanAcademy, name: "Khan Academy" },
    { address: TEST_CHARITIES.girlsWhoCode, name: "Girls Who Code" },
  ];

  for (const charity of charities) {
    console.log(`  Verifying ${charity.name}...`);
    const tx = await contract.addVerifiedCharity(charity.address, charity.name);
    await tx.wait();
  }
  console.log("[OK] All 12 charities verified\n");
}

/**
 * Creates 3 sample portfolio funds for user testing.
 * @param {object} contract - The PortfolioFunds contract instance
 */
async function createTestFunds(contract) {
  // 1. Environmental Impact Fund (4 charities, 25% each)
  console.log("  Creating Environmental Impact Fund...");
  let tx = await contract.createPortfolioFund(
    "Environmental Impact Fund",
    "Supporting environmental sustainability and climate action worldwide through ocean cleanup, forest preservation, renewable energy access, and reforestation efforts.",
    [
      TEST_CHARITIES.oceanCleanup,
      TEST_CHARITIES.rainforestAlliance,
      TEST_CHARITIES.solarSister,
      TEST_CHARITIES.treesForFuture,
    ],
    [
      "Ocean Cleanup Foundation",
      "Rainforest Alliance",
      "Solar Sister",
      "Trees for the Future",
    ],
  );
  await tx.wait();
  console.log("  [OK] Environmental Impact Fund created");

  // 2. Poverty Relief Impact Fund (4 charities, 25% each)
  console.log("  Creating Poverty Relief Impact Fund...");
  tx = await contract.createPortfolioFund(
    "Poverty Relief Impact Fund",
    "Fighting global poverty through direct cash transfers, microfinance, humanitarian aid, and sustainable agricultural development programs.",
    [
      TEST_CHARITIES.giveDirectly,
      TEST_CHARITIES.grameenFoundation,
      TEST_CHARITIES.oxfamInternational,
      TEST_CHARITIES.heiferInternational,
    ],
    [
      "GiveDirectly",
      "Grameen Foundation",
      "Oxfam International",
      "Heifer International",
    ],
  );
  await tx.wait();
  console.log("  [OK] Poverty Relief Impact Fund created");

  // 3. Education Impact Fund (4 charities, 25% each)
  console.log("  Creating Education Impact Fund...");
  tx = await contract.createPortfolioFund(
    "Education Impact Fund",
    "Expanding access to quality education globally through literacy programs, teacher training, online learning platforms, and technology education initiatives.",
    [
      TEST_CHARITIES.roomToRead,
      TEST_CHARITIES.teachForAll,
      TEST_CHARITIES.khanAcademy,
      TEST_CHARITIES.girlsWhoCode,
    ],
    [
      "Room to Read",
      "Teach for All",
      "Khan Academy",
      "Girls Who Code",
    ],
  );
  await tx.wait();
  console.log("  [OK] Education Impact Fund created");

  // Print fund summary
  console.log("\n  Created Portfolio Funds:");
  const allFunds = await contract.getAllActiveFunds();
  for (let i = 0; i < allFunds.length; i++) {
    const details = await contract.getFundDetails(allFunds[i]);
    console.log(`    ${i + 1}. ${details.name}`);
    console.log(`       Fund ID: ${allFunds[i]}`);
    console.log(`       Charities: ${details.charities.length}`);
    console.log(`       Distribution: ${details.ratios[0] / 100n}% each`);
  }
}

/**
 * Deploys PortfolioFunds as a UUPS proxy to Moonbase Alpha,
 * registers test charities, and creates 3 sample portfolio funds.
 *
 * The deployer wallet keeps ADMIN_ROLE so you can manage the contract
 * during testing. For production, roles should be transferred to a
 * timelock controller (see deploy-universal.cjs).
 */
async function main() {
  const networkName = hre.network.name;
  if (networkName !== "moonbase") {
    throw new Error(
      `This script targets Moonbase Alpha. Got: ${networkName}\n` +
      "Run with: npx hardhat run scripts/deploy-portfolio-funds-testnet.cjs --network moonbase",
    );
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("PortfolioFunds — Moonbase Alpha Testnet Deployment");
  console.log(`${"=".repeat(60)}\n`);

  // --- Deployer info ---
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} DEV\n`);

  if (balance === 0n) {
    throw new Error(
      "Deployer has no DEV tokens.\n" +
      "Get testnet DEV from: https://faucet.moonbeam.network/",
    );
  }

  // Treasury = deployer for testnet (receives the 0.5% platform fee)
  const treasuryAddress = process.env.MOONBEAM_TREASURY_ADDRESS || deployer.address;
  console.log(`Treasury: ${treasuryAddress}`);
  if (treasuryAddress === deployer.address) {
    console.log("[INFO] Using deployer as treasury (testnet default)\n");
  }

  // --- Step 1: Deploy UUPS proxy ---
  console.log("[1/3] Deploying PortfolioFunds (UUPS proxy)...");
  const PortfolioFunds = await hre.ethers.getContractFactory("PortfolioFunds");
  const portfolio = await hre.upgrades.deployProxy(
    PortfolioFunds,
    [treasuryAddress, deployer.address], // deployer keeps admin for testing
    { initializer: "initialize", kind: "uups" },
  );
  await portfolio.waitForDeployment();

  const proxyAddress = await portfolio.getAddress();
  const implAddress = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log(`[OK] Proxy:          ${proxyAddress}`);
  console.log(`     Implementation: ${implAddress}`);

  // Confirm settings
  const feeRate = await portfolio.platformFeeRate();
  const savedTreasury = await portfolio.treasury();
  console.log(`     Fee rate:       ${feeRate} bps (${feeRate / 100n}%)`);
  console.log(`     Treasury:       ${savedTreasury}\n`);

  // --- Step 2: Register test charities ---
  console.log("[2/3] Registering verified charities...");
  await setupVerifiedCharities(portfolio);

  // --- Step 3: Create sample portfolio funds ---
  console.log("[3/3] Creating portfolio funds...");
  await createTestFunds(portfolio);

  // --- Save deployment info ---
  const deploymentPath = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentPath)) {
    fs.mkdirSync(deploymentPath, { recursive: true });
  }

  // Update moonbase.json
  const moonbaseFile = path.join(deploymentPath, "moonbase.json");
  let moonbaseInfo = {};
  if (fs.existsSync(moonbaseFile)) {
    moonbaseInfo = JSON.parse(fs.readFileSync(moonbaseFile, "utf8"));
  }
  if (!moonbaseInfo.contracts) {
    moonbaseInfo.contracts = {};
  }
  moonbaseInfo.contracts.PortfolioFunds = proxyAddress;
  moonbaseInfo.contracts.PortfolioFundsImpl = implAddress;
  moonbaseInfo.lastUpdated = new Date().toISOString();
  fs.writeFileSync(moonbaseFile, JSON.stringify(moonbaseInfo, null, 2));

  // Update addresses.json
  const addressesFile = path.join(deploymentPath, "addresses.json");
  let addresses = {};
  if (fs.existsSync(addressesFile)) {
    addresses = JSON.parse(fs.readFileSync(addressesFile, "utf8"));
  }
  if (!addresses.moonbase) {
    addresses.moonbase = { network: "moonbase", chainId: 1287, contracts: {} };
  }
  addresses.moonbase.contracts.PortfolioFunds = proxyAddress;
  fs.writeFileSync(addressesFile, JSON.stringify(addresses, null, 2));

  // --- Summary ---
  console.log(`\n${"=".repeat(60)}`);
  console.log("DEPLOYMENT COMPLETE");
  console.log(`${"=".repeat(60)}`);
  console.log(`\nPortfolioFunds proxy: ${proxyAddress}`);
  console.log(`Implementation:       ${implAddress}`);
  console.log(`Platform fee:         ${feeRate} bps (${feeRate / 100n}%)`);
  console.log(`Treasury:             ${savedTreasury}`);
  console.log("\nDeployment saved to:");
  console.log(`  ${moonbaseFile}`);
  console.log(`  ${addressesFile}`);

  console.log(`\n${"-".repeat(60)}`);
  console.log("NEXT STEPS");
  console.log(`${"-".repeat(60)}`);
  console.log("\n1. Update your webapp .env with:\n");
  console.log(`   VITE_MOONBASE_PORTFOLIO_FUNDS_ADDRESS=${proxyAddress}\n`);
  console.log("2. Restart the webapp dev server:\n");
  console.log("   cd ~/projects/give-protocol-webapp && npm run dev\n");
  console.log("3. Connect MetaMask to Moonbase Alpha (chainId 1287)");
  console.log("   RPC: https://rpc.api.moonbase.moonbeam.network");
  console.log("   Get DEV tokens: https://faucet.moonbeam.network/\n");

  // --- Verify on Moonscan ---
  if (process.env.MOONSCAN_API_KEY) {
    console.log("Waiting 30s for Moonscan to index...");
    await new Promise((r) => setTimeout(r, 30000));
    try {
      await hre.run("verify:verify", {
        address: implAddress,
        constructorArguments: [],
      });
      console.log("[OK] Implementation verified on Moonscan");
    } catch (error) {
      if (error.message.includes("already verified")) {
        console.log("[OK] Already verified on Moonscan");
      } else {
        console.log(`[WARN] Verification failed: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error("\n[ERROR]", error);
  process.exitCode = 1;
});
