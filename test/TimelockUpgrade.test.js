const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TimelockUpgrade", () => {
  let donation = null;
  let timelock = null;
  let owner = null;
  let treasury = null;
  let proposer = null;
  let executor = null;

  const MIN_DELAY = 3600; // 1 hour for testing (shorter than prod)

  beforeEach(async () => {
    [owner, treasury, proposer, executor] = await ethers.getSigners();

    // Deploy TimelockController
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelock = await TimelockController.deploy(
      MIN_DELAY,
      [proposer.address], // proposers
      [executor.address], // executors
      ethers.ZeroAddress,  // admin = address(0) → self-governing
    );
    await timelock.waitForDeployment();

    // Deploy DurationDonation proxy with timelock as owner
    const DurationDonation = await ethers.getContractFactory("DurationDonation");
    donation = await hre.upgrades.deployProxy(
      DurationDonation,
      [treasury.address, await timelock.getAddress()],
      { initializer: "initialize", kind: "uups" },
    );
    await donation.waitForDeployment();
  });

  describe("Timelock-governed ownership", () => {
    it("Should set timelock as contract owner", async () => {
      expect(await donation.owner()).to.equal(await timelock.getAddress());
    });

    it("Should reject direct calls to owner-only functions", async () => {
      await expect(
        donation.connect(owner).updateTreasury(owner.address),
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
    });

    it("Should execute owner-only calls through timelock after delay", async () => {
      const newTreasury = ethers.Wallet.createRandom().address;
      const donationAddr = await donation.getAddress();

      // Encode the call
      const callData = donation.interface.encodeFunctionData("updateTreasury", [newTreasury]);

      // Schedule through timelock
      const predecessor = ethers.ZeroHash;
      const salt = ethers.id("update-treasury-1");

      await timelock.connect(proposer).schedule(
        donationAddr,
        0, // value
        callData,
        predecessor,
        salt,
        MIN_DELAY,
      );

      // Should fail before delay
      await expect(
        timelock.connect(executor).execute(donationAddr, 0, callData, predecessor, salt),
      ).to.be.reverted;

      // Advance time past delay
      await time.increase(MIN_DELAY + 1);

      // Execute
      await timelock.connect(executor).execute(donationAddr, 0, callData, predecessor, salt);

      // Verify treasury was updated
      expect(await donation.giveProtocolTreasury()).to.equal(newTreasury);
    });
  });

  describe("Timelock-governed upgrade", () => {
    it("Should execute upgrade through timelock after delay", async () => {
      const proxyAddr = await donation.getAddress();

      // Update treasury to verify state preservation across the upgrade
      const newTreasury = ethers.Wallet.createRandom().address;
      const updateData = donation.interface.encodeFunctionData("updateTreasury", [newTreasury]);
      const regSalt = ethers.id("update-treasury-pre-upgrade");

      await timelock.connect(proposer).schedule(proxyAddr, 0, updateData, ethers.ZeroHash, regSalt, MIN_DELAY);
      await time.increase(MIN_DELAY + 1);
      await timelock.connect(executor).execute(proxyAddr, 0, updateData, ethers.ZeroHash, regSalt);

      // Deploy new implementation
      const V2 = await ethers.getContractFactory("DurationDonation");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const v2Addr = await v2Impl.getAddress();

      // Encode upgradeToAndCall
      const upgradeData = donation.interface.encodeFunctionData("upgradeToAndCall", [v2Addr, "0x"]);
      const upgradeSalt = ethers.id("upgrade-v2");

      // Schedule upgrade
      await timelock.connect(proposer).schedule(proxyAddr, 0, upgradeData, ethers.ZeroHash, upgradeSalt, MIN_DELAY);

      // Should fail before delay
      await expect(
        timelock.connect(executor).execute(proxyAddr, 0, upgradeData, ethers.ZeroHash, upgradeSalt),
      ).to.be.reverted;

      // Advance time
      await time.increase(MIN_DELAY + 1);

      // Execute upgrade
      await timelock.connect(executor).execute(proxyAddr, 0, upgradeData, ethers.ZeroHash, upgradeSalt);

      // Verify state preserved after upgrade
      expect(await donation.giveProtocolTreasury()).to.equal(newTreasury);

      // Verify proxy address unchanged
      expect(await donation.getAddress()).to.equal(proxyAddr);
    });

    it("Should reject upgrade without timelock", async () => {
      const V2 = await ethers.getContractFactory("DurationDonation", owner);
      await expect(
        hre.upgrades.upgradeProxy(await donation.getAddress(), V2, { kind: "uups" }),
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
    });

    it("Should emit Upgraded event when upgrading through timelock", async () => {
      const proxyAddr = await donation.getAddress();

      // Deploy new implementation
      const V2 = await ethers.getContractFactory("DurationDonation");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const v2Addr = await v2Impl.getAddress();

      // Encode upgradeToAndCall
      const upgradeData = donation.interface.encodeFunctionData("upgradeToAndCall", [v2Addr, "0x"]);
      const salt = ethers.id("upgrade-event-test");

      // Schedule and execute upgrade through timelock
      await timelock.connect(proposer).schedule(proxyAddr, 0, upgradeData, ethers.ZeroHash, salt, MIN_DELAY);
      await time.increase(MIN_DELAY + 1);

      await expect(
        timelock.connect(executor).execute(proxyAddr, 0, upgradeData, ethers.ZeroHash, salt),
      ).to.emit(donation, "Upgraded").withArgs(v2Addr);
    });

    it("Should atomically set Stage-1 caps + allowlist via upgradeToAndCall(initializeV2)", async () => {
      const proxyAddr = await donation.getAddress();

      // Deploy new implementation
      const V2 = await ethers.getContractFactory("DurationDonation");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();

      const dummyToken = ethers.Wallet.createRandom().address;
      const perTxCap = ethers.parseEther("500");
      const dailyCap = ethers.parseEther("2500");

      // Encode upgradeToAndCall with initializeV2 payload (native + one ERC20)
      const initData = donation.interface.encodeFunctionData("initializeV2", [
        [dummyToken, ethers.ZeroAddress],
        [
          [true, perTxCap, dailyCap, 0n, 0n],
          [true, perTxCap, dailyCap, 0n, 0n],
        ],
      ]);
      const upgradeData = donation.interface.encodeFunctionData("upgradeToAndCall", [
        await v2Impl.getAddress(),
        initData,
      ]);
      const salt = ethers.id("upgrade-v2-initialized");

      await timelock.connect(proposer).schedule(proxyAddr, 0, upgradeData, ethers.ZeroHash, salt, MIN_DELAY);
      await time.increase(MIN_DELAY + 1);
      await timelock.connect(executor).execute(proxyAddr, 0, upgradeData, ethers.ZeroHash, salt);

      // Caps + allowlist were applied in the same call
      const nativeCfg = await donation.tokenConfigs(ethers.ZeroAddress);
      expect(nativeCfg.enabled).to.equal(true);
      expect(nativeCfg.perTxCap).to.equal(perTxCap);
      expect(nativeCfg.dailyCap).to.equal(dailyCap);

      const tokenCfg = await donation.tokenConfigs(dummyToken);
      expect(tokenCfg.enabled).to.equal(true);

      // Deny-by-default: an unconfigured token is still disabled
      const otherToken = ethers.Wallet.createRandom().address;
      const otherCfg = await donation.tokenConfigs(otherToken);
      expect(otherCfg.enabled).to.equal(false);
    });
  });
});
