const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("DonationV3 (Non-Upgradeable V2 Donation Contract)", () => {
  let donation = null;
  let registry = null;
  let token = null;
  let owner = null;
  let charity = null;
  let donor = null;
  let treasury = null;
  let nonOwner = null;

  const FEE_RATE = 50n; // 0.5% in basis points (MVP-DON-02)
  const BASIS_POINTS = 10000n;
  const MINIMUM_DONATION = ethers.parseEther("0.001");
  const STAGE1_PER_TX_CAP = ethers.parseEther("500.0");
  const STAGE1_DAILY_CAP = ethers.parseEther("2500.0");
  const SAMPLE_CAUSE_ID = ethers.id("clean-water-initiative-2026");

  beforeEach(async () => {
    [owner, charity, donor, treasury, nonOwner] = await ethers.getSigners();

    // Deploy mock ERC20 token
    const MockToken = await ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("Mock Token", "MTK");
    await token.waitForDeployment();
    await token.mint(donor.address, ethers.parseEther("10000.0"));

    // Deploy standalone CharityRegistry (non-upgradeable, MVP-SEC-05)
    const CharityRegistry = await ethers.getContractFactory("CharityRegistry");
    registry = await CharityRegistry.deploy(owner.address);
    await registry.waitForDeployment();

    // Register charity in the standalone registry
    await registry.registerCharity(charity.address);

    // Deploy non-upgradeable DonationV3 wired to CharityRegistry with Stage-1 caps
    const DonationV3 = await ethers.getContractFactory("DonationV3");
    const tokenAddr = await token.getAddress();
    donation = await DonationV3.deploy(
      treasury.address,
      owner.address,
      await registry.getAddress(),
      [tokenAddr, ethers.ZeroAddress],
      [
        {
          enabled: true,
          perTxCap: STAGE1_PER_TX_CAP,
          dailyCap: STAGE1_DAILY_CAP,
          dailyWindowStart: 0n,
          dailyVolume: 0n,
        },
        {
          enabled: true,
          perTxCap: STAGE1_PER_TX_CAP,
          dailyCap: STAGE1_DAILY_CAP,
          dailyWindowStart: 0n,
          dailyVolume: 0n,
        },
      ],
    );
    await donation.waitForDeployment();
  });

  describe("Non-Upgradeable Deployment & MVP-DON-02 Fee Invariant", () => {
    it("Should expose no proxy or upgrade entry points (Option A non-upgradeable)", () => {
      expect(donation.upgradeToAndCall).to.be.undefined;
      expect(donation.initialize).to.be.undefined;
      expect(donation.initializeV2).to.be.undefined;
      expect(donation.proxiableUUID).to.be.undefined;
    });

    it("Should initialize platformFeeRate to 50 bps (0.5%) and assert post-deploy", async () => {
      const rate = await donation.platformFeeRate();
      expect(rate).to.equal(50n);
      expect(await donation.DEFAULT_FEE_RATE()).to.equal(50n);
    });

    it("Should expose MINIMUM_DONATION as 0.001 token units", async () => {
      expect(await donation.MINIMUM_DONATION()).to.equal(MINIMUM_DONATION);
    });

    it("Should set the correct treasury, owner, and standalone CharityRegistry", async () => {
      expect(await donation.giveProtocolTreasury()).to.equal(treasury.address);
      expect(await donation.owner()).to.equal(owner.address);
      expect(await donation.charityRegistry()).to.equal(await registry.getAddress());
    });

    it("Should revert deployment with zero treasury address", async () => {
      const DonationV3 = await ethers.getContractFactory("DonationV3");
      await expect(
        DonationV3.deploy(
          ethers.ZeroAddress,
          owner.address,
          await registry.getAddress(),
          [],
          [],
        ),
      ).to.be.revertedWith("Invalid treasury address");
    });

    it("Should revert deployment with zero owner address", async () => {
      const DonationV3 = await ethers.getContractFactory("DonationV3");
      await expect(
        DonationV3.deploy(
          treasury.address,
          ethers.ZeroAddress,
          await registry.getAddress(),
          [],
          [],
        ),
      ).to.be.revertedWithCustomError(donation, "OwnableInvalidOwner");
    });

    it("Should revert deployment if initialTokens and initialConfigs length mismatch", async () => {
      const DonationV3 = await ethers.getContractFactory("DonationV3");
      await expect(
        DonationV3.deploy(
          treasury.address,
          owner.address,
          await registry.getAddress(),
          [await token.getAddress()],
          [],
        ),
      ).to.be.revertedWithCustomError(donation, "InvalidAmount");
    });

    it("Should allow deferred set-once CharityRegistry wiring when deployed with address(0)", async () => {
      const DonationV3 = await ethers.getContractFactory("DonationV3");
      const unwired = await DonationV3.deploy(
        treasury.address,
        owner.address,
        ethers.ZeroAddress,
        [],
        [],
      );
      await unwired.waitForDeployment();
      expect(await unwired.charityRegistry()).to.equal(ethers.ZeroAddress);

      await expect(unwired.setCharityRegistry(await registry.getAddress()))
        .to.emit(unwired, "CharityRegistryWired")
        .withArgs(await registry.getAddress());

      expect(await unwired.charityRegistry()).to.equal(await registry.getAddress());

      // Cannot be overwritten once set
      await expect(
        unwired.setCharityRegistry(await registry.getAddress()),
      ).to.be.revertedWith("Registry already set");
    });

    it("Should reject overwriting CharityRegistry when already wired in constructor", async () => {
      await expect(
        donation.setCharityRegistry(await registry.getAddress()),
      ).to.be.revertedWith("Registry already set");
    });
  });

  describe("MVP-DON-04: Cause-ID Event Field & Donation Flows", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("10000.0"));
    });

    it("Should emit causeId in DonationProcessed for ERC20 donation with explicit causeId", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const platformTip = ethers.parseEther("5.0");
      const expectedFee = (charityAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNet = charityAmount - expectedFee;
      const expectedTreasury = expectedFee + platformTip;

      const tx = await donation.connect(donor)[
        "processDonation(address,address,uint256,uint256,bytes32)"
      ](
        charity.address,
        await token.getAddress(),
        charityAmount,
        platformTip,
        SAMPLE_CAUSE_ID,
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment && log.fragment.name === "DonationProcessed",
      );
      expect(event).to.not.be.undefined;
      expect(event.args.donor).to.equal(donor.address);
      expect(event.args.charity).to.equal(charity.address);
      expect(event.args.token).to.equal(await token.getAddress());
      expect(event.args.charityAmount).to.equal(expectedNet);
      expect(event.args.platformTip).to.equal(expectedTreasury);
      expect(event.args.totalTaxDeductible).to.equal(charityAmount + platformTip);
      expect(event.args.causeId).to.equal(SAMPLE_CAUSE_ID);

      // Verify tax receipt also records causeId
      const taxReceipt = await donation.getTaxReceipt(event.args.donationId);
      expect(taxReceipt.causeId).to.equal(SAMPLE_CAUSE_ID);
      expect(taxReceipt.donor).to.equal(donor.address);
      expect(taxReceipt.primaryBeneficiary).to.equal(charity.address);
      expect(taxReceipt.charityAmount).to.equal(expectedNet);
      expect(taxReceipt.giveProtocolAmount).to.equal(expectedTreasury);
      expect(taxReceipt.totalTaxDeductible).to.equal(charityAmount + platformTip);
    });

    it("Should default causeId to bytes32(0) on 4-arg processDonation overload", async () => {
      const charityAmount = ethers.parseEther("50.0");

      const tx = await donation.connect(donor)[
        "processDonation(address,address,uint256,uint256)"
      ](
        charity.address,
        await token.getAddress(),
        charityAmount,
        0n,
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment && log.fragment.name === "DonationProcessed",
      );
      expect(event.args.causeId).to.equal(ethers.ZeroHash);
    });

    it("Should emit causeId in DonationProcessed for native donation with explicit causeId", async () => {
      const grossAmount = ethers.parseEther("10.0");
      const platformTip = ethers.parseEther("1.0");
      const totalValue = grossAmount + platformTip;
      const expectedFee = (grossAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNet = grossAmount - expectedFee;
      const expectedTreasury = expectedFee + platformTip;

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const charityBefore = await ethers.provider.getBalance(charity.address);

      const tx = await donation.connect(donor)[
        "donateNative(address,uint256,bytes32)"
      ](charity.address, platformTip, SAMPLE_CAUSE_ID, { value: totalValue });

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment && log.fragment.name === "DonationProcessed",
      );
      expect(event.args.causeId).to.equal(SAMPLE_CAUSE_ID);
      expect(event.args.charityAmount).to.equal(expectedNet);
      expect(event.args.platformTip).to.equal(expectedTreasury);
      expect(event.args.totalTaxDeductible).to.equal(totalValue);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const charityAfter = await ethers.provider.getBalance(charity.address);
      expect(treasuryAfter - treasuryBefore).to.equal(expectedTreasury);
      expect(charityAfter - charityBefore).to.equal(expectedNet);
    });

    it("Should default causeId to bytes32(0) on 2-arg donateNative overload", async () => {
      const grossAmount = ethers.parseEther("1.0");

      const tx = await donation.connect(donor)[
        "donateNative(address,uint256)"
      ](charity.address, 0n, { value: grossAmount });

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment && log.fragment.name === "DonationProcessed",
      );
      expect(event.args.causeId).to.equal(ethers.ZeroHash);
    });

    it("Should thread causeId through processDonationWithPercentageTip and processDonationWithSuggestedTip", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const causeA = ethers.id("education-fund-a");
      const causeB = ethers.id("medical-relief-b");

      const tx1 = await donation.connect(donor)[
        "processDonationWithPercentageTip(address,address,uint256,uint256,bytes32)"
      ](charity.address, await token.getAddress(), charityAmount, 500n, causeA);
      const r1 = await tx1.wait();
      const ev1 = r1.logs.find((l) => l.fragment && l.fragment.name === "DonationProcessed");
      expect(ev1.args.causeId).to.equal(causeA);

      const tx2 = await donation.connect(donor)[
        "processDonationWithSuggestedTip(address,address,uint256,uint8,bytes32)"
      ](charity.address, await token.getAddress(), charityAmount, 1, causeB);
      const r2 = await tx2.wait();
      const ev2 = r2.logs.find((l) => l.fragment && l.fragment.name === "DonationProcessed");
      expect(ev2.args.causeId).to.equal(causeB);
    });
  });

  describe("MVP-SEC-05: Standalone CharityRegistry Consumption", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("10000.0"));
    });

    it("Should read registration and active status directly from standalone CharityRegistry", async () => {
      const newCharity = ethers.Wallet.createRandom().address;
      let info = await donation.getCharityInfo(newCharity);
      expect(info.isRegistered).to.equal(false);
      expect(info.isActive).to.equal(false);

      await registry.registerCharity(newCharity);
      info = await donation.getCharityInfo(newCharity);
      expect(info.isRegistered).to.equal(true);
      expect(info.isActive).to.equal(true);

      await registry.updateCharityStatus(newCharity, false);
      info = await donation.getCharityInfo(newCharity);
      expect(info.isRegistered).to.equal(true);
      expect(info.isActive).to.equal(false);
    });

    it("Should revert donations to unregistered or deactivated charities in the standalone registry", async () => {
      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          nonOwner.address,
          await token.getAddress(),
          ethers.parseEther("10.0"),
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.be.revertedWithCustomError(donation, "CharityNotRegistered");

      await registry.updateCharityStatus(charity.address, false);
      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          await token.getAddress(),
          ethers.parseEther("10.0"),
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.be.revertedWithCustomError(donation, "CharityNotActive");
    });

    it("Should share the standalone CharityRegistry across a newly deployed DonationV3 instance without re-registering charities", async () => {
      const DonationV3 = await ethers.getContractFactory("DonationV3");
      const tokenAddr = await token.getAddress();
      const secondDonationV3 = await DonationV3.deploy(
        treasury.address,
        owner.address,
        await registry.getAddress(),
        [tokenAddr],
        [
          {
            enabled: true,
            perTxCap: STAGE1_PER_TX_CAP,
            dailyCap: STAGE1_DAILY_CAP,
            dailyWindowStart: 0n,
            dailyVolume: 0n,
          },
        ],
      );
      await secondDonationV3.waitForDeployment();

      const info = await secondDonationV3.getCharityInfo(charity.address);
      expect(info.isRegistered).to.equal(true);
      expect(info.isActive).to.equal(true);

      await token.connect(donor).approve(await secondDonationV3.getAddress(), ethers.parseEther("100.0"));
      await expect(
        secondDonationV3.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          tokenAddr,
          ethers.parseEther("25.0"),
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.emit(secondDonationV3, "DonationProcessed");
    });
  });

  describe("MVP-SEC-02: Per-Token Allowlist & Per-Tx / Rolling-24h Caps", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("10000.0"));
    });

    it("Should enforce deny-by-default on unconfigured ERC20 tokens", async () => {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const unallowed = await MockToken.deploy("Unallowed", "UNA");
      await unallowed.waitForDeployment();
      await unallowed.mint(donor.address, ethers.parseEther("100.0"));
      await unallowed.connect(donor).approve(await donation.getAddress(), ethers.parseEther("100.0"));

      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          await unallowed.getAddress(),
          ethers.parseEther("10.0"),
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.be.revertedWithCustomError(donation, "TokenNotAllowed");
    });

    it("Should enforce Stage-1 per-tx cap ($500 / 500 token units)", async () => {
      // Exactly at 500 cap succeeds
      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          await token.getAddress(),
          STAGE1_PER_TX_CAP,
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.emit(donation, "DonationProcessed");

      // 500 + 1 wei reverts with ExceedsPerTxCap
      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          await token.getAddress(),
          STAGE1_PER_TX_CAP + 1n,
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.be.revertedWithCustomError(donation, "ExceedsPerTxCap");
    });

    it("Should enforce Stage-1 rolling-24h daily cap ($2,500 / 2,500 token units) and reset after 24h", async () => {
      const tokenAddr = await token.getAddress();

      // 5 transactions of 500 = 2,500 (reaches daily cap)
      for (let i = 0; i < 5; i++) {
        await donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](charity.address, tokenAddr, STAGE1_PER_TX_CAP, 0n, SAMPLE_CAUSE_ID);
      }

      // 6th transaction in same 24h window reverts with ExceedsDailyCap
      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          tokenAddr,
          ethers.parseEther("1.0"),
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.be.revertedWithCustomError(donation, "ExceedsDailyCap");

      // Advance past 24h window
      await time.increase(24 * 60 * 60 + 1);

      // Window resets and donation succeeds
      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          tokenAddr,
          STAGE1_PER_TX_CAP,
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.emit(donation, "DonationProcessed");
    });

    it("Should allow owner to batch-configure tokens via setTokenConfigs and disable removed tokens", async () => {
      const tokenAddr = await token.getAddress();
      await donation.setTokenConfigs(
        [tokenAddr],
        [
          {
            enabled: false,
            perTxCap: 0n,
            dailyCap: 0n,
            dailyWindowStart: 0n,
            dailyVolume: 0n,
          },
        ],
      );

      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          tokenAddr,
          ethers.parseEther("10.0"),
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.be.revertedWithCustomError(donation, "TokenNotAllowed");
    });

    it("Should reject invalid token cap parameters and unauthorized callers", async () => {
      const tokenAddr = await token.getAddress();

      await expect(
        donation.connect(nonOwner).setTokenConfig(tokenAddr, true, STAGE1_PER_TX_CAP, STAGE1_DAILY_CAP),
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");

      await expect(
        donation.setTokenConfig(tokenAddr, true, 0n, STAGE1_DAILY_CAP),
      ).to.be.revertedWithCustomError(donation, "InvalidAmount");

      await expect(
        donation.setTokenConfig(tokenAddr, true, STAGE1_DAILY_CAP, STAGE1_PER_TX_CAP),
      ).to.be.revertedWithCustomError(donation, "InvalidAmount");
    });
  });

  describe("Access Controls, Fee Bounds, Treasury & Pausing", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("1000.0"));
    });

    it("Should enforce MAX_FEE_RATE (500 bps) and onlyOwner on updatePlatformFeeRate", async () => {
      await expect(
        donation.connect(nonOwner).updatePlatformFeeRate(100n),
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");

      await expect(
        donation.updatePlatformFeeRate(501n),
      ).to.be.revertedWithCustomError(donation, "InvalidFeeRate");

      await expect(donation.updatePlatformFeeRate(100n))
        .to.emit(donation, "PlatformFeeRateUpdated")
        .withArgs(50n, 100n);
      expect(await donation.platformFeeRate()).to.equal(100n);
    });

    it("Should enforce non-zero address and onlyOwner on updateTreasury", async () => {
      await expect(
        donation.connect(nonOwner).updateTreasury(nonOwner.address),
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");

      await expect(
        donation.updateTreasury(ethers.ZeroAddress),
      ).to.be.revertedWith("Invalid treasury address");

      await expect(donation.updateTreasury(nonOwner.address))
        .to.emit(donation, "TreasuryUpdated")
        .withArgs(treasury.address, nonOwner.address);
      expect(await donation.giveProtocolTreasury()).to.equal(nonOwner.address);
    });

    it("Should pause and unpause donation flows (onlyOwner)", async () => {
      await expect(donation.connect(nonOwner).pause()).to.be.revertedWithCustomError(
        donation,
        "OwnableUnauthorizedAccount",
      );

      await donation.pause();
      expect(await donation.paused()).to.equal(true);

      await expect(
        donation.connect(donor)[
          "processDonation(address,address,uint256,uint256,bytes32)"
        ](
          charity.address,
          await token.getAddress(),
          ethers.parseEther("10.0"),
          0n,
          SAMPLE_CAUSE_ID,
        ),
      ).to.be.revertedWithCustomError(donation, "EnforcedPause");

      await expect(
        donation.connect(donor)[
          "donateNative(address,uint256,bytes32)"
        ](charity.address, 0n, SAMPLE_CAUSE_ID, { value: ethers.parseEther("1.0") }),
      ).to.be.revertedWithCustomError(donation, "EnforcedPause");

      await donation.unpause();
      expect(await donation.paused()).to.equal(false);
    });
  });
});
