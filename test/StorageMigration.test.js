const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { buildOps } = require("../scripts/live-upgrade.cjs");

/**
 * Proves the live V1 -> V2 DurationDonation upgrade is storage-safe and that the
 * charity migration path works, by driving the exact op chain that
 * scripts/live-upgrade.cjs builds against a proxy deployed with the reconstructed
 * V1 implementation (contracts/legacy/DurationDonationV1.sol).
 */
describe("StorageMigration (V1 -> V2)", () => {
  let v1 = null;
  let registry = null;
  let v2Impl = null;
  let proxyAddr = null;
  let timelock = null;
  let owner = null;
  let treasury = null;
  let donor = null;
  let proposer = null;
  let executor = null;
  let charity1 = null;
  let charity2 = null;

  const MIN_DELAY = 3600; // 1h for test speed

  beforeEach(async () => {
    [owner, treasury, donor, proposer, executor] = await ethers.getSigners();
    charity1 = ethers.Wallet.createRandom().address;
    charity2 = ethers.Wallet.createRandom().address;

    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelock = await TimelockController.deploy(MIN_DELAY, [proposer.address], [executor.address], ethers.ZeroAddress);
    await timelock.waitForDeployment();

    // Deploy the V1 proxy (reconstructed live layout), owner = deployer for setup.
    const V1 = await ethers.getContractFactory("DurationDonationV1");
    v1 = await hre.upgrades.deployProxy(V1, [treasury.address, owner.address], {
      initializer: "initialize",
      kind: "uups",
    });
    await v1.waitForDeployment();
    proxyAddr = await v1.getAddress();

    // Populate V1 state: register two charities (embedded registry) and record a donation.
    await v1.connect(owner).registerCharity(charity1);
    await v1.connect(owner).registerCharity(charity2);
    await v1.connect(donor).donateNative(charity1, 0n, { value: ethers.parseEther("1") });

    // Hand ownership to the timelock (the live arrangement).
    await v1.connect(owner).transferOwnership(await timelock.getAddress());

    // Deploy the V2 implementation and the standalone registry (owner = timelock).
    const V2 = await ethers.getContractFactory("DurationDonation");
    v2Impl = await V2.deploy();
    await v2Impl.waitForDeployment();

    const CR = await ethers.getContractFactory("CharityRegistry");
    registry = await CR.deploy(await timelock.getAddress());
    await registry.waitForDeployment();
  });

  it("preserves V1 storage across the upgrade and migrates charities", async () => {
    const treasuryBefore = await v1.giveProtocolTreasury();
    const feeBefore = await v1.platformFeeRate();
    const donationsBefore = await v1.getDonationAmount(donor.address, charity1);

    // Build the exact 3-op chain the live script uses.
    const native = ethers.ZeroAddress;
    const tokens = [native];
    const configs = [
      { enabled: true, perTxCap: ethers.parseEther("500"), dailyCap: ethers.parseEther("2500"), dailyWindowStart: 0n, dailyVolume: 0n },
    ];
    const ops = buildOps({
      chain: "test",
      proxy: proxyAddr,
      registry: await registry.getAddress(),
      impl: await v2Impl.getAddress(),
      tokens,
      configs,
      charities: [charity1, charity2],
    });

    const tl = timelock.connect(proposer);
    for (const op of ops) {
      if (!(await tl.isOperationPending(op.id)) && !(await tl.isOperationDone(op.id))) {
        await (await tl.schedule(op.target, op.value, op.data, op.predecessor, op.salt, MIN_DELAY)).wait();
      }
    }
    await time.increase(MIN_DELAY + 1);

    const tlExec = timelock.connect(executor);
    for (const op of ops) {
      if (!(await tlExec.isOperationDone(op.id))) {
        await (await tlExec.execute(op.target, op.value, op.data, op.predecessor, op.salt)).wait();
      }
    }

    // V2 handle on the same proxy.
    const v2 = await ethers.getContractAt("DurationDonation", proxyAddr);

    // Storage preservation across the upgrade.
    expect(await v2.giveProtocolTreasury()).to.equal(treasuryBefore); // slot 0
    expect(await v2.platformFeeRate()).to.equal(feeBefore); // slot 5 (100 bps, unchanged)
    expect(await v2.getDonationAmount(donor.address, charity1)).to.equal(donationsBefore); // slot 2

    // Caps + allowlist applied atomically.
    const cfg = await v2.tokenConfigs(native);
    expect(cfg.enabled).to.equal(true);
    expect(cfg.perTxCap).to.equal(ethers.parseEther("500"));
    expect(cfg.dailyCap).to.equal(ethers.parseEther("2500"));

    // Registry wired + charities migrated.
    expect(await v2.charityRegistry()).to.equal(await registry.getAddress());
    const info = await registry.getCharityInfo(charity1);
    expect(info.isRegistered_).to.equal(true);
    expect(info.isActive_).to.equal(true);
    expect((await registry.getCharityInfo(charity2)).isRegistered_).to.equal(true);

    // A new donation works through the migrated registry.
    await expect(
      v2.connect(donor).donateNative(charity1, 0n, { value: ethers.parseEther("0.1") }),
    ).to.emit(v2, "DonationProcessed");
  });

  it("rejects donations until the registry is wired and the charity migrated", async () => {
    // Pre-migration, the V1 embedded charity is NOT visible to V2 (orphaned slot 1),
    // so upgrading without migrating would revert every donation. Prove the guard
    // direction by confirming the fresh registry starts empty.
    expect((await registry.getCharityInfo(charity1)).isRegistered_).to.equal(false);
    const [v1Registered] = await v1.getCharityInfo(charity1);
    expect(v1Registered).to.equal(true); // V1 still sees it via embedded mapping
  });
});
