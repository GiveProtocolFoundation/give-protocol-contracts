const { expect } = require("chai");
const { STAGE1_TOKEN_CONFIGS, stage1TokenConfigFor } = require("../scripts/stage1-token-config.cjs");

/**
 * Unit tests for the deploy-universal Stage-1 token-config resolver — the
 * "MOCK" resolution, the "refuse to deploy" guard, and the struct encoding.
 */
describe("stage1-token-config", () => {
  it("resolves MOCK to the deployed MockERC20 for testnets", () => {
    const mock = "0xMock000000000000000000000000000000000000";
    const { tokens, configs } = stage1TokenConfigFor("baseSepolia", mock);
    expect(tokens).to.deep.equal([mock]);
    expect(configs).to.have.length(1);
    expect(configs[0]).to.deep.equal({
      enabled: true,
      perTxCap: 1000000000000000000000000n,
      dailyCap: 5000000000000000000000000n,
      dailyWindowStart: 0n,
      dailyVolume: 0n,
    });
  });

  it("throws when a MOCK config is requested without a MockERC20 address", () => {
    expect(() => stage1TokenConfigFor("baseSepolia", null)).to.throw(/no MockERC20 was deployed/);
  });

  it("refuses to deploy a chain with no reviewed config", () => {
    expect(() => stage1TokenConfigFor("optimism", null)).to.throw(/No Stage-1 token config for optimism/);
    expect(() => stage1TokenConfigFor("moonbeam", null)).to.throw(/No Stage-1 token config for moonbeam/);
  });

  it("resolves a multi-token mainnet config (arbitrum: WETH + DAI + ARB)", () => {
    const { tokens, configs } = stage1TokenConfigFor("arbitrum", null);
    expect(tokens).to.have.length(3);
    expect(configs).to.have.length(3);
    expect(tokens[2]).to.equal("0x912CE59144191C1204E64559FE8253a0e49E6548"); // ARB
    expect(configs[2].perTxCap).to.equal(3048780400000000000000n);
    expect(configs[2].dailyCap).to.equal(15243902400000000000000n);
  });

  it("has an entry for every configured chain and none for the unsupported mainnets", () => {
    expect(Object.keys(STAGE1_TOKEN_CONFIGS).sort()).to.deep.equal(
      ["arbitrum", "avalanche", "base", "baseSepolia", "ethereum", "moonbase", "optimismSepolia", "polygon"].sort(),
    );
  });
});
