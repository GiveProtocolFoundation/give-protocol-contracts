const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("CharityRegistry", () => {
  let registry = null;
  let owner = null;
  let nonOwner = null;
  let charity = null;

  beforeEach(async () => {
    [owner, nonOwner, charity] = await ethers.getSigners();
    const CharityRegistry = await ethers.getContractFactory("CharityRegistry");
    registry = await CharityRegistry.deploy(owner.address);
    await registry.waitForDeployment();
  });

  describe("Deployment", () => {
    it("Should set the deployer as owner", async () => {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("Should be non-upgradeable (no upgrade entry points)", async () => {
      // A standalone contract has no proxy or upgrade API. The absence of a
      // UUPS/transparent proxy surface is structural: there is no
      // upgradeToAndCall / implementation function exposed.
      expect(registry.upgradeToAndCall).to.be.undefined;
      expect(registry.implementation).to.be.undefined;
    });
  });

  describe("Registration", () => {
    it("Should allow owner to register a charity", async () => {
      await expect(registry.registerCharity(charity.address))
        .to.emit(registry, "CharityRegistered");

      const info = await registry.getCharityInfo(charity.address);
      expect(info.isRegistered_).to.equal(true);
      expect(info.walletAddress).to.equal(charity.address);
      expect(info.isActive_).to.equal(true);
    });

    it("Should expose isRegistered / isActive view helpers", async () => {
      await registry.registerCharity(charity.address);
      expect(await registry.isRegistered(charity.address)).to.equal(true);
      expect(await registry.isActive(charity.address)).to.equal(true);
      expect(await registry.isRegistered(ethers.Wallet.createRandom().address)).to.equal(false);
    });

    it("Should reject non-owner registration", async () => {
      await expect(
        registry.connect(nonOwner).registerCharity(charity.address),
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("Should reject zero-address registration", async () => {
      await expect(
        registry.registerCharity(ethers.ZeroAddress),
      ).to.be.revertedWith("Invalid charity address");
    });

    it("Should reject duplicate registration", async () => {
      await registry.registerCharity(charity.address);
      await expect(
        registry.registerCharity(charity.address),
      ).to.be.revertedWith("Charity already registered");
    });

    it("Should batch-register charities idempotently", async () => {
      const a = ethers.Wallet.createRandom().address;
      const b = ethers.Wallet.createRandom().address;
      await registry.registerCharities([a, b]);
      expect(await registry.isRegistered(a)).to.equal(true);
      expect(await registry.isRegistered(b)).to.equal(true);

      // Re-running with an already-registered + zero address must not revert.
      await registry.registerCharities([a, ethers.ZeroAddress]);
      expect(await registry.isRegistered(a)).to.equal(true);
    });
  });

  describe("Status updates", () => {
    beforeEach(async () => {
      await registry.registerCharity(charity.address);
    });

    it("Should allow owner to deactivate/reactivate a charity", async () => {
      await expect(registry.updateCharityStatus(charity.address, false))
        .to.emit(registry, "CharityStatusUpdated")
        .withArgs(charity.address, false);
      expect(await registry.isActive(charity.address)).to.equal(false);

      await registry.updateCharityStatus(charity.address, true);
      expect(await registry.isActive(charity.address)).to.equal(true);
    });

    it("Should reject status update for unregistered charity", async () => {
      await expect(
        registry.updateCharityStatus(ethers.Wallet.createRandom().address, false),
      ).to.be.revertedWithCustomError(registry, "CharityNotRegistered");
    });

    it("Should reject non-owner status update", async () => {
      await expect(
        registry.connect(nonOwner).updateCharityStatus(charity.address, false),
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("Ownership transfer", () => {
    it("Should allow owner to transfer ownership", async () => {
      await registry.transferOwnership(nonOwner.address);
      expect(await registry.owner()).to.equal(nonOwner.address);
    });
  });
});