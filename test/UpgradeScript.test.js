const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const {
  opId,
  buildInitializeV2Data,
  buildUpgradeData,
  buildSetRegistryData,
  buildRegisterData,
  buildOps,
} = require("../scripts/live-upgrade.cjs");

const DurationDonationArtifact = require("../artifacts/contracts/DurationDonation.sol/DurationDonation.json");
const CharityRegistryArtifact = require("../artifacts/contracts/CharityRegistry.sol/CharityRegistry.json");

describe("live-upgrade.cjs (pure helpers)", () => {
  let timelock = null;
  let proposer = null;

  beforeEach(async () => {
    [proposer] = await ethers.getSigners();
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelock = await TimelockController.deploy(259200, [proposer.address], [proposer.address], ethers.ZeroAddress);
    await timelock.waitForDeployment();
  });

  it("builds a 3-op chain whose calldata matches the contract interface exactly", () => {
    const dd = new ethers.Interface(DurationDonationArtifact.abi);
    const cr = new ethers.Interface(CharityRegistryArtifact.abi);

    const proxy = ethers.Wallet.createRandom().address;
    const impl = ethers.Wallet.createRandom().address;
    const registry = ethers.Wallet.createRandom().address;
    const native = ethers.ZeroAddress;
    const charity = ethers.Wallet.createRandom().address;

    const tokens = [native];
    const configs = [
      { enabled: true, perTxCap: ethers.parseEther("500"), dailyCap: ethers.parseEther("2500"), dailyWindowStart: 0n, dailyVolume: 0n },
    ];
    const charities = [charity];

    const ops = buildOps({ chain: "base", proxy, registry, impl, tokens, configs, charities });

    expect(ops).to.have.length(3);
    expect(ops[0].name).to.equal("upgrade-to-v2");
    expect(ops[1].name).to.equal("wire-charity-registry");
    expect(ops[2].name).to.equal("migrate-charities");

    // Predecessor chain enforces ordering on-chain.
    expect(ops[0].predecessor).to.equal(ethers.ZeroHash);
    expect(ops[1].predecessor).to.equal(ops[0].id);
    expect(ops[2].predecessor).to.equal(ops[1].id);

    // Target routing.
    expect(ops[0].target).to.equal(proxy);
    expect(ops[1].target).to.equal(proxy);
    expect(ops[2].target).to.equal(registry);

    // Calldata equivalence against the real interfaces.
    const initData = buildInitializeV2Data(dd, tokens, configs);
    const expectedInit = dd.encodeFunctionData("initializeV2", [tokens, configs]);
    expect(initData).to.equal(expectedInit);

    const upgradeData = buildUpgradeData(dd, impl, initData);
    expect(upgradeData).to.equal(dd.encodeFunctionData("upgradeToAndCall", [impl, initData]));
    expect(ops[0].data).to.equal(upgradeData);

    expect(buildSetRegistryData(dd, registry)).to.equal(dd.encodeFunctionData("setCharityRegistry", [registry]));
    expect(ops[1].data).to.equal(buildSetRegistryData(dd, registry));

    expect(buildRegisterData(cr, charities)).to.equal(cr.encodeFunctionData("registerCharities", [charities]));
    expect(ops[2].data).to.equal(buildRegisterData(cr, charities));
  });

  it("derives operation ids that match TimelockController.hashOperation", async () => {
    const proxy = ethers.Wallet.createRandom().address;
    const impl = ethers.Wallet.createRandom().address;
    const registry = ethers.Wallet.createRandom().address;

    const tokens = [ethers.ZeroAddress];
    const configs = [{ enabled: true, perTxCap: 1n, dailyCap: 2n, dailyWindowStart: 0n, dailyVolume: 0n }];
    const charities = [ethers.Wallet.createRandom().address];

    const ops = buildOps({ chain: "base", proxy, registry, impl, tokens, configs, charities });

    for (const op of ops) {
      const onChain = await timelock.hashOperation(op.target, op.value, op.data, op.predecessor, op.salt);
      expect(opId(op)).to.equal(onChain);
      expect(op.id).to.equal(onChain);
    }
  });

  it("rejects an out-of-order or non-chained predecessor chain", () => {
    const proxy = ethers.Wallet.createRandom().address;
    const impl = ethers.Wallet.createRandom().address;
    const registry = ethers.Wallet.createRandom().address;
    const tokens = [ethers.ZeroAddress];
    const configs = [{ enabled: true, perTxCap: 1n, dailyCap: 2n, dailyWindowStart: 0n, dailyVolume: 0n }];
    const charities = [ethers.Wallet.createRandom().address];

    const ops = buildOps({ chain: "base", proxy, registry, impl, tokens, configs, charities });
    // The migration op must wait on the wiring op, which must wait on the upgrade.
    expect(ops[2].predecessor).to.not.equal(ethers.ZeroHash);
    expect(ops[2].predecessor).to.equal(ops[1].id);
    expect(ops[1].predecessor).to.equal(ops[0].id);
  });
});
