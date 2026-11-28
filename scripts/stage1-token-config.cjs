/**
 * Stage-1 per-chain token allowlist + caps + minimum for scripts/deploy-universal.cjs.
 * Extracted into its own module so the "refuse to deploy" and "MOCK" resolution
 * logic is unit-testable without running the full deploy script.
 */

// Stage-1 per-chain token allowlist + caps + minimum, initialized via initializeV2
// (DurationDonation) or the DonationV3 constructor after deploy. Caps and the
// minimum are TOKEN UNITS (the donation contract has no price oracle); mainnet
// values mirror deployments/upgrade-config.json ($500/tx, $2,500/24h at pinned
// 90-day averages). minDonationWei is the GROSS (pre-fee) minimum in token units:
// 18-decimal tokens keep 1e15 (0.001 token, preserving the legacy MINIMUM_DONATION
// behavior); 6-decimal stablecoins (USDC/USDT) use 1e6 (== $1), matching the
// webapp's per-token minDonation. "MOCK" resolves to the freshly deployed
// MockERC20 (testnets only). Any network absent here REFUSES to deploy: a
// deny-by-default tokenConfigs would accept no donations, so an unreviewed config
// is unsafe.
const STAGE1_TOKEN_CONFIGS = {
  // ---- Testnets: the freshly deployed MockERC20 with generous finite caps ----
  baseSepolia: [
    { token: "MOCK", enabled: true, perTxCapWei: "1000000000000000000000000", dailyCapWei: "5000000000000000000000000", minDonationWei: "1000000000000000" },
  ],
  optimismSepolia: [
    { token: "MOCK", enabled: true, perTxCapWei: "1000000000000000000000000", dailyCapWei: "5000000000000000000000000", minDonationWei: "1000000000000000" },
  ],
  moonbase: [
    { token: "MOCK", enabled: true, perTxCapWei: "1000000000000000000000000", dailyCapWei: "5000000000000000000000000", minDonationWei: "1000000000000000" },
  ],
  // ---- Mainnets: canonical wrapped/stable tokens ----
  base: [
    { token: "0x4200000000000000000000000000000000000006", enabled: true, perTxCapWei: "206800000000000000", dailyCapWei: "1034300000000000000", minDonationWei: "1000000000000000", note: "18dp; WETH" },
    { token: "0x50c5725949A6f0C72e6C4a641F24049b1AE50DB8", enabled: true, perTxCapWei: "500000000000000000000", dailyCapWei: "2500000000000000000000", minDonationWei: "1000000000000000", note: "18dp; DAI" },
    { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDC (native)" },
    { token: "0xfde4c96C8593536E31f229d6156B4D8d02642F84", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDT (bridged)" },
  ],
  ethereum: [
    { token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", enabled: true, perTxCapWei: "206800000000000000", dailyCapWei: "1034300000000000000", minDonationWei: "1000000000000000", note: "18dp; WETH" },
    { token: "0x6B175474E89094C44Da98b954EedeAC495271d0F", enabled: true, perTxCapWei: "500000000000000000000", dailyCapWei: "2500000000000000000000", minDonationWei: "1000000000000000", note: "18dp; DAI" },
    { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDC" },
    { token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDT" },
  ],
  arbitrum: [
    { token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", enabled: true, perTxCapWei: "206800000000000000", dailyCapWei: "1034300000000000000", minDonationWei: "1000000000000000", note: "18dp; WETH" },
    { token: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", enabled: true, perTxCapWei: "500000000000000000000", dailyCapWei: "2500000000000000000000", minDonationWei: "1000000000000000", note: "18dp; DAI" },
    { token: "0x912CE59144191C1204E64559FE8253a0e49E6548", enabled: true, perTxCapWei: "3048780400000000000000", dailyCapWei: "15243902400000000000000", minDonationWei: "1000000000000000", note: "18dp; ARB" },
    { token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDC (native)" },
    { token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDT" },
  ],
  polygon: [
    { token: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", enabled: true, perTxCapWei: "206800000000000000", dailyCapWei: "1034300000000000000", minDonationWei: "1000000000000000", note: "18dp; WETH" },
    { token: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", enabled: true, perTxCapWei: "500000000000000000000", dailyCapWei: "2500000000000000000000", minDonationWei: "1000000000000000", note: "18dp; DAI" },
    { token: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDC (native)" },
    { token: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDT" },
  ],
  avalanche: [
    { token: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", enabled: true, perTxCapWei: "56382400000000000000", dailyCapWei: "281912400000000000000", minDonationWei: "1000000000000000", note: "18dp; WAVAX" },
    { token: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", enabled: true, perTxCapWei: "500000000000000000000", dailyCapWei: "2500000000000000000000", minDonationWei: "1000000000000000", note: "18dp; DAI.e" },
    { token: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDC" },
    { token: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDT" },
  ],
  optimism: [
    { token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDC (native)" },
    { token: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", enabled: true, perTxCapWei: "500000000", dailyCapWei: "2500000000", minDonationWei: "1000000", note: "6dp; USDT" },
  ],
  // moonbeam mainnet: intentionally absent → deploy-universal refuses until a
  // reviewed token config is added.
};

/**
 * Resolve the Stage-1 token config for a network into { tokens, configs } for
 * DurationDonation.initializeV2 / DonationV3 constructor. "MOCK" entries resolve
 * to the freshly deployed MockERC20 (testnets only). Throws when the network has
 * no config.
 * @param {string} networkName - hre.network.name.
 * @param {string|null} mockTokenAddress - deployed MockERC20 address (testnets).
 * @returns {{tokens: string[], configs: Array<object>}}
 */
function stage1TokenConfigFor(networkName, mockTokenAddress) {
  const entries = STAGE1_TOKEN_CONFIGS[networkName];
  if (!entries || entries.length === 0) {
    throw new Error(
      `No Stage-1 token config for ${networkName} — refusing to deploy. ` +
        "A deny-by-default tokenConfigs would accept no donations. " +
        "Add an entry to STAGE1_TOKEN_CONFIGS in scripts/stage1-token-config.cjs.",
    );
  }
  const tokens = [];
  const configs = [];
  for (const t of entries) {
    const token = t.token === "MOCK" ? mockTokenAddress : t.token;
    if (!token) {
      throw new Error(
        `Stage-1 token config for ${networkName} references MOCK but no MockERC20 was deployed.`,
      );
    }
    tokens.push(token);
    configs.push({
      enabled: Boolean(t.enabled),
      perTxCap: BigInt(t.perTxCapWei),
      dailyCap: BigInt(t.dailyCapWei),
      dailyWindowStart: 0n,
      dailyVolume: 0n,
      minDonation: BigInt(t.minDonationWei),
    });
  }
  return { tokens, configs };
}

module.exports = { STAGE1_TOKEN_CONFIGS, stage1TokenConfigFor };
