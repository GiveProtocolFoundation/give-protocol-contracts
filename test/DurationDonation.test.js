const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("DurationDonation", () => {
  let donation = null;
  let token = null;
  let owner = null;
  let charity = null;
  let donor = null;
  let treasury = null;
  let nonOwner = null;

  const FEE_RATE = 100n; // 1% in basis points
  const BASIS_POINTS = 10000n;
  const MINIMUM_DONATION = ethers.parseEther("0.001");

  beforeEach(async () => {
    [owner, charity, donor, treasury, nonOwner] = await ethers.getSigners();

    // Deploy mock ERC20 token
    const MockToken = await ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("Mock Token", "MTK");
    await token.mint(donor.address, ethers.parseEther("1000.0"));

    // Deploy donation contract via proxy
    const DurationDonation = await ethers.getContractFactory("DurationDonation");
    donation = await hre.upgrades.deployProxy(
      DurationDonation,
      [treasury.address, owner.address],
      { initializer: "initialize", kind: "uups" },
    );
    await donation.waitForDeployment();

    // Register charity
    await donation.registerCharity(charity.address);

    // Enable the mock token + native asset with generous caps so the existing
    // donation-path tests exercise the cap plumbing without tripping limits.
    const NO_CAP = ethers.MaxUint256;
    await donation.setTokenConfig(await token.getAddress(), true, NO_CAP, NO_CAP);
    await donation.setTokenConfig(ethers.ZeroAddress, true, NO_CAP, NO_CAP);
  });

  describe("Deployment", () => {
    it("Should set the correct treasury address", async () => {
      expect(await donation.giveProtocolTreasury()).to.equal(treasury.address);
    });

    it("Should set the correct platform fee rate", async () => {
      expect(await donation.platformFeeRate()).to.equal(FEE_RATE);
    });

    it("Should revert with zero treasury address", async () => {
      const DurationDonation = await ethers.getContractFactory("DurationDonation");
      await expect(
        hre.upgrades.deployProxy(
          DurationDonation,
          [ethers.ZeroAddress, owner.address],
          { initializer: "initialize", kind: "uups" },
        ),
      ).to.be.revertedWith("Invalid treasury address");
    });
  });

  describe("Charity Registration", () => {
    it("Should allow owner to register a charity", async () => {
      const newCharity = ethers.Wallet.createRandom().address;
      await expect(donation.registerCharity(newCharity))
        .to.emit(donation, "CharityRegistered");

      const charityInfo = await donation.getCharityInfo(newCharity);
      expect(charityInfo.isRegistered).to.equal(true);
      expect(charityInfo.isActive).to.equal(true);
    });

    it("Should not allow non-owner to register a charity", async () => {
      const newCharity = ethers.Wallet.createRandom().address;
      await expect(
        donation.connect(donor).registerCharity(newCharity)
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
    });

    it("Should not allow registering zero address", async () => {
      await expect(
        donation.registerCharity(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid charity address");
    });

    it("Should not allow registering same charity twice", async () => {
      await expect(
        donation.registerCharity(charity.address)
      ).to.be.revertedWith("Charity already registered");
    });
  });

  describe("Charity Status", () => {
    it("Should allow owner to update charity status", async () => {
      await expect(donation.updateCharityStatus(charity.address, false))
        .to.emit(donation, "CharityStatusUpdated")
        .withArgs(charity.address, false);

      const charityInfo = await donation.getCharityInfo(charity.address);
      expect(charityInfo.isActive).to.equal(false);
    });

    it("Should not allow updating unregistered charity", async () => {
      await expect(
        donation.updateCharityStatus(nonOwner.address, false)
      ).to.be.revertedWithCustomError(donation, "CharityNotRegistered");
    });

    it("Should not allow non-owner to update charity status", async () => {
      await expect(
        donation.connect(donor).updateCharityStatus(charity.address, false)
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
    });
  });

  describe("Treasury Management", () => {
    it("Should allow owner to update treasury", async () => {
      const newTreasury = nonOwner.address;
      await expect(donation.updateTreasury(newTreasury))
        .to.emit(donation, "TreasuryUpdated")
        .withArgs(treasury.address, newTreasury);

      expect(await donation.giveProtocolTreasury()).to.equal(newTreasury);
    });

    it("Should not allow zero address for treasury", async () => {
      await expect(
        donation.updateTreasury(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid treasury address");
    });

    it("Should not allow non-owner to update treasury", async () => {
      await expect(
        donation.connect(donor).updateTreasury(nonOwner.address)
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
    });
  });

  describe("ERC20 Token Donations", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("1000.0"));
    });

    it("Should process ERC20 donation with mandatory fee", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const platformTip = 0n;
      const expectedFee = (charityAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNetToCharity = charityAmount - expectedFee;

      const treasuryBalanceBefore = await token.balanceOf(treasury.address);
      const charityBalanceBefore = await token.balanceOf(charity.address);

      await expect(
        donation.connect(donor).processDonation(
          charity.address,
          await token.getAddress(),
          charityAmount,
          platformTip
        )
      ).to.emit(donation, "DonationProcessed");

      const treasuryBalanceAfter = await token.balanceOf(treasury.address);
      const charityBalanceAfter = await token.balanceOf(charity.address);

      // Check fee went to treasury
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
      // Check net amount went to charity
      expect(charityBalanceAfter - charityBalanceBefore).to.equal(expectedNetToCharity);
    });

    it("Should process ERC20 donation with fee and optional tip", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const platformTip = ethers.parseEther("10.0"); // 10% tip
      const expectedFee = (charityAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNetToCharity = charityAmount - expectedFee;
      const expectedToTreasury = expectedFee + platformTip;

      const treasuryBalanceBefore = await token.balanceOf(treasury.address);
      const charityBalanceBefore = await token.balanceOf(charity.address);

      await donation.connect(donor).processDonation(
        charity.address,
        await token.getAddress(),
        charityAmount,
        platformTip
      );

      const treasuryBalanceAfter = await token.balanceOf(treasury.address);
      const charityBalanceAfter = await token.balanceOf(charity.address);

      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedToTreasury);
      expect(charityBalanceAfter - charityBalanceBefore).to.equal(expectedNetToCharity);
    });

    it("Should not allow donation to unregistered charity", async () => {
      await expect(
        donation.connect(donor).processDonation(
          nonOwner.address,
          await token.getAddress(),
          ethers.parseEther("10.0"),
          0n
        )
      ).to.be.revertedWithCustomError(donation, "CharityNotRegistered");
    });

    it("Should not allow donation to inactive charity", async () => {
      await donation.updateCharityStatus(charity.address, false);

      await expect(
        donation.connect(donor).processDonation(
          charity.address,
          await token.getAddress(),
          ethers.parseEther("10.0"),
          0n
        )
      ).to.be.revertedWithCustomError(donation, "CharityNotActive");
    });

    it("Should not allow donation below minimum", async () => {
      await expect(
        donation.connect(donor).processDonation(
          charity.address,
          await token.getAddress(),
          MINIMUM_DONATION - 1n,
          0n
        )
      ).to.be.revertedWithCustomError(donation, "InvalidAmount");
    });

    it("Should track donation amounts correctly", async () => {
      const charityAmount = ethers.parseEther("50.0");
      const expectedFee = (charityAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNetToCharity = charityAmount - expectedFee;

      await donation.connect(donor).processDonation(
        charity.address,
        await token.getAddress(),
        charityAmount,
        0n
      );

      const donationAmount = await donation.getDonationAmount(donor.address, charity.address);
      expect(donationAmount).to.equal(expectedNetToCharity);

      const charityInfo = await donation.getCharityInfo(charity.address);
      expect(charityInfo.totalReceived).to.equal(expectedNetToCharity);
    });
  });

  describe("Percentage-based Tips", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("1000.0"));
    });

    it("Should process donation with percentage tip", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const tipPercentage = 500n; // 5%
      const expectedTip = (charityAmount * tipPercentage) / BASIS_POINTS;
      const expectedFee = (charityAmount * FEE_RATE) / BASIS_POINTS;
      const expectedToTreasury = expectedFee + expectedTip;

      const treasuryBalanceBefore = await token.balanceOf(treasury.address);

      await donation.connect(donor).processDonationWithPercentageTip(
        charity.address,
        await token.getAddress(),
        charityAmount,
        tipPercentage
      );

      const treasuryBalanceAfter = await token.balanceOf(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedToTreasury);
    });
  });

  describe("Suggested Tips", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("1000.0"));
    });

    it("Should return correct suggested tip rates", async () => {
      const rates = await donation.getSuggestedTipRates();
      expect(rates.length).to.equal(3);
      expect(rates[0]).to.equal(500n);  // 5%
      expect(rates[1]).to.equal(1000n); // 10%
      expect(rates[2]).to.equal(2000n); // 20%
    });

    it("Should calculate suggested tip correctly", async () => {
      const donationAmount = ethers.parseEther("100.0");

      // 5% tip
      const tip0 = await donation.calculateSuggestedTip(donationAmount, 0);
      expect(tip0).to.equal(ethers.parseEther("5.0"));

      // 10% tip
      const tip1 = await donation.calculateSuggestedTip(donationAmount, 1);
      expect(tip1).to.equal(ethers.parseEther("10.0"));

      // 20% tip
      const tip2 = await donation.calculateSuggestedTip(donationAmount, 2);
      expect(tip2).to.equal(ethers.parseEther("20.0"));
    });

    it("Should revert with invalid tip option", async () => {
      await expect(
        donation.calculateSuggestedTip(ethers.parseEther("100.0"), 3)
      ).to.be.revertedWithCustomError(donation, "InvalidTipOption");
    });

    it("Should process donation with suggested tip option 0 (5%)", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const expectedTip = ethers.parseEther("5.0"); // 5%
      const expectedFee = (charityAmount * FEE_RATE) / BASIS_POINTS;
      const expectedToTreasury = expectedFee + expectedTip;

      const treasuryBalanceBefore = await token.balanceOf(treasury.address);

      await donation.connect(donor).processDonationWithSuggestedTip(
        charity.address,
        await token.getAddress(),
        charityAmount,
        0 // 5% option
      );

      const treasuryBalanceAfter = await token.balanceOf(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedToTreasury);
    });

    it("Should process donation with suggested tip option 2 (20%)", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const expectedTip = ethers.parseEther("20.0"); // 20%
      const expectedFee = (charityAmount * FEE_RATE) / BASIS_POINTS;
      const expectedToTreasury = expectedFee + expectedTip;

      const treasuryBalanceBefore = await token.balanceOf(treasury.address);

      await donation.connect(donor).processDonationWithSuggestedTip(
        charity.address,
        await token.getAddress(),
        charityAmount,
        2 // 20% option
      );

      const treasuryBalanceAfter = await token.balanceOf(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedToTreasury);
    });

    it("Should revert with invalid suggested tip option", async () => {
      await expect(
        donation.connect(donor).processDonationWithSuggestedTip(
          charity.address,
          await token.getAddress(),
          ethers.parseEther("100.0"),
          5 // Invalid option
        )
      ).to.be.revertedWithCustomError(donation, "InvalidTipOption");
    });
  });

  describe("Native Token Donations", () => {
    it("Should process native donation with mandatory fee", async () => {
      const grossAmount = ethers.parseEther("1.0");
      const platformTip = 0n;
      const expectedFee = (grossAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNetToCharity = grossAmount - expectedFee;

      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);
      const charityBalanceBefore = await ethers.provider.getBalance(charity.address);

      await donation.connect(donor).donateNative(charity.address, platformTip, {
        value: grossAmount,
      });

      const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);
      const charityBalanceAfter = await ethers.provider.getBalance(charity.address);

      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
      expect(charityBalanceAfter - charityBalanceBefore).to.equal(expectedNetToCharity);
    });

    it("Should process native donation with fee and optional tip", async () => {
      const grossAmount = ethers.parseEther("1.0");
      const platformTip = ethers.parseEther("0.1");
      const totalSent = grossAmount + platformTip;
      const expectedFee = (grossAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNetToCharity = grossAmount - expectedFee;
      const expectedToTreasury = expectedFee + platformTip;

      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);
      const charityBalanceBefore = await ethers.provider.getBalance(charity.address);

      await donation.connect(donor).donateNative(charity.address, platformTip, {
        value: totalSent,
      });

      const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);
      const charityBalanceAfter = await ethers.provider.getBalance(charity.address);

      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedToTreasury);
      expect(charityBalanceAfter - charityBalanceBefore).to.equal(expectedNetToCharity);
    });

    it("Should not allow native donation to unregistered charity", async () => {
      await expect(
        donation.connect(donor).donateNative(nonOwner.address, 0n, {
          value: ethers.parseEther("1.0"),
        })
      ).to.be.revertedWithCustomError(donation, "CharityNotRegistered");
    });

    it("Should not allow native donation to inactive charity", async () => {
      await donation.updateCharityStatus(charity.address, false);

      await expect(
        donation.connect(donor).donateNative(charity.address, 0n, {
          value: ethers.parseEther("1.0"),
        })
      ).to.be.revertedWithCustomError(donation, "CharityNotActive");
    });

    it("Should not allow native donation below minimum", async () => {
      await expect(
        donation.connect(donor).donateNative(charity.address, 0n, {
          value: MINIMUM_DONATION - 1n,
        })
      ).to.be.revertedWithCustomError(donation, "InvalidAmount");
    });
  });

  describe("Tax Receipts", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("1000.0"));
    });

    it("Should generate tax receipt for ERC20 donation", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const platformTip = ethers.parseEther("10.0");

      const tx = await donation.connect(donor).processDonation(
        charity.address,
        await token.getAddress(),
        charityAmount,
        platformTip
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => log.fragment && log.fragment.name === "TaxReceiptGenerated"
      );

      expect(event).to.not.be.undefined;

      const receiptId = event.args[0];
      const taxReceipt = await donation.getTaxReceipt(receiptId);

      expect(taxReceipt.donor).to.equal(donor.address);
      expect(taxReceipt.primaryBeneficiary).to.equal(charity.address);
      expect(taxReceipt.tokenAddress).to.equal(await token.getAddress());
      expect(taxReceipt.receiptType).to.equal("DUAL_BENEFICIARY");
    });

    it("Should generate dual beneficiary receipt even with no tip (due to mandatory fee)", async () => {
      const charityAmount = ethers.parseEther("100.0");
      const platformTip = 0n;

      const tx = await donation.connect(donor).processDonation(
        charity.address,
        await token.getAddress(),
        charityAmount,
        platformTip
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => log.fragment && log.fragment.name === "TaxReceiptGenerated"
      );

      const receiptId = event.args[0];
      const taxReceipt = await donation.getTaxReceipt(receiptId);

      // Even with no optional tip, the mandatory platform fee means treasury receives funds
      // So it's still a dual beneficiary scenario
      expect(taxReceipt.receiptType).to.equal("DUAL_BENEFICIARY");
    });

    it("Should generate tax receipt for native donation", async () => {
      const grossAmount = ethers.parseEther("1.0");
      const platformTip = ethers.parseEther("0.1");

      const tx = await donation.connect(donor).donateNative(charity.address, platformTip, {
        value: grossAmount + platformTip,
      });

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => log.fragment && log.fragment.name === "TaxReceiptGenerated"
      );

      expect(event).to.not.be.undefined;

      const receiptId = event.args[0];
      const taxReceipt = await donation.getTaxReceipt(receiptId);

      expect(taxReceipt.donor).to.equal(donor.address);
      expect(taxReceipt.primaryBeneficiary).to.equal(charity.address);
      expect(taxReceipt.tokenAddress).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Fee Management", () => {
    it("Should allow owner to update fee rate", async () => {
      const newFeeRate = 200n;

      await expect(donation.updatePlatformFeeRate(newFeeRate))
        .to.emit(donation, "PlatformFeeRateUpdated")
        .withArgs(FEE_RATE, newFeeRate);

      expect(await donation.platformFeeRate()).to.equal(newFeeRate);
    });

    it("Should not allow fee rate above maximum", async () => {
      const excessiveFeeRate = 600n;

      await expect(
        donation.updatePlatformFeeRate(excessiveFeeRate)
      ).to.be.revertedWithCustomError(donation, "InvalidFeeRate");
    });

    it("Should not allow non-owner to update fee rate", async () => {
      await expect(
        donation.connect(donor).updatePlatformFeeRate(200n)
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
    });
  });

  describe("Token Caps & Allowlist", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("1000.0"));
    });

    describe("Allowlist (deny-by-default)", () => {
      it("Should revert an ERC20 donation for a token that is not allowlisted", async () => {
        const Other = await ethers.getContractFactory("MockERC20");
        const other = await Other.deploy("Other Token", "OTH");
        await other.waitForDeployment();
        await other.mint(donor.address, ethers.parseEther("1000.0"));
        await other.connect(donor).approve(await donation.getAddress(), ethers.parseEther("1000.0"));

        await expect(
          donation.connect(donor).processDonation(
            charity.address,
            await other.getAddress(),
            ethers.parseEther("10.0"),
            0n,
          ),
        ).to.be.revertedWithCustomError(donation, "TokenNotAllowed");
      });

      it("Should revert a native donation when native is not allowlisted", async () => {
        await donation.setTokenConfig(ethers.ZeroAddress, false, 0n, 0n);

        await expect(
          donation.connect(donor).donateNative(charity.address, 0n, {
            value: ethers.parseEther("1.0"),
          }),
        ).to.be.revertedWithCustomError(donation, "TokenNotAllowed");
      });
    });

    describe("Per-transaction cap", () => {
      it("Should revert when charityAmount exceeds the per-tx cap", async () => {
        const perTxCap = ethers.parseEther("500.0");
        await donation.setTokenConfig(await token.getAddress(), true, perTxCap, ethers.MaxUint256);

        await expect(
          donation.connect(donor).processDonation(
            charity.address,
            await token.getAddress(),
            perTxCap + 1n,
            0n,
          ),
        ).to.be.revertedWithCustomError(donation, "ExceedsPerTxCap");
      });

      it("Should allow a donation exactly at the per-tx cap", async () => {
        const perTxCap = ethers.parseEther("500.0");
        await donation.setTokenConfig(await token.getAddress(), true, perTxCap, ethers.MaxUint256);

        await expect(
          donation.connect(donor).processDonation(
            charity.address,
            await token.getAddress(),
            perTxCap,
            0n,
          ),
        ).to.emit(donation, "DonationProcessed");
      });

      it("Should enforce per-tx cap on native donations", async () => {
        const perTxCap = ethers.parseEther("500.0");
        await donation.setTokenConfig(ethers.ZeroAddress, true, perTxCap, ethers.MaxUint256);

        await expect(
          donation.connect(donor).donateNative(charity.address, 0n, {
            value: perTxCap + 1n,
          }),
        ).to.be.revertedWithCustomError(donation, "ExceedsPerTxCap");
      });
    });

    describe("Rolling-24h daily cap", () => {
      it("Should revert when accumulated volume exceeds the daily cap", async () => {
        const perTxCap = ethers.parseEther("800.0");
        const dailyCap = ethers.parseEther("1000.0");
        await donation.setTokenConfig(await token.getAddress(), true, perTxCap, dailyCap);

        await donation.connect(donor).processDonation(
          charity.address,
          await token.getAddress(),
          ethers.parseEther("600.0"),
          0n,
        );

        await expect(
          donation.connect(donor).processDonation(
            charity.address,
            await token.getAddress(),
            ethers.parseEther("600.0"),
            0n,
          ),
        ).to.be.revertedWithCustomError(donation, "ExceedsDailyCap");
      });

      it("Should reset the daily window after 24h and allow donations again", async () => {
        const perTxCap = ethers.parseEther("500.0");
        const dailyCap = ethers.parseEther("500.0");
        await donation.setTokenConfig(await token.getAddress(), true, perTxCap, dailyCap);

        await donation.connect(donor).processDonation(
          charity.address,
          await token.getAddress(),
          ethers.parseEther("400.0"),
          0n,
        );

        await expect(
          donation.connect(donor).processDonation(
            charity.address,
            await token.getAddress(),
            ethers.parseEther("400.0"),
            0n,
          ),
        ).to.be.revertedWithCustomError(donation, "ExceedsDailyCap");

        await time.increase(24 * 60 * 60 + 1);

        await expect(
          donation.connect(donor).processDonation(
            charity.address,
            await token.getAddress(),
            ethers.parseEther("400.0"),
            0n,
          ),
        ).to.emit(donation, "DonationProcessed");
      });
    });

    describe("Token config admin", () => {
      it("Should emit TokenConfigUpdated when configuring a token", async () => {
        const perTxCap = ethers.parseEther("500.0");
        const dailyCap = ethers.parseEther("2500.0");

        await expect(
          donation.setTokenConfig(await token.getAddress(), true, perTxCap, dailyCap),
        ).to.emit(donation, "TokenConfigUpdated")
          .withArgs(await token.getAddress(), true, perTxCap, dailyCap);

        const cfg = await donation.tokenConfigs(await token.getAddress());
        expect(cfg.enabled).to.equal(true);
        expect(cfg.perTxCap).to.equal(perTxCap);
        expect(cfg.dailyCap).to.equal(dailyCap);
      });

      it("Should reject a non-owner setting token config", async () => {
        await expect(
          donation.connect(donor).setTokenConfig(
            await token.getAddress(),
            true,
            ethers.parseEther("1.0"),
            ethers.parseEther("1.0"),
          ),
        ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
      });

      it("Should reject an enabled token with a zero per-tx cap", async () => {
        await expect(
          donation.setTokenConfig(await token.getAddress(), true, 0n, ethers.parseEther("1.0")),
        ).to.be.revertedWithCustomError(donation, "InvalidAmount");
      });

      it("Should reject an enabled token whose daily cap is below its per-tx cap", async () => {
        await expect(
          donation.setTokenConfig(
            await token.getAddress(),
            true,
            ethers.parseEther("100.0"),
            ethers.parseEther("50.0"),
          ),
        ).to.be.revertedWithCustomError(donation, "InvalidAmount");
      });
    });

    describe("Atomic upgrade (initializeV2)", () => {
      it("Should set Stage-1 caps + allowlist atomically via upgradeToAndCall", async () => {
        const V2 = await ethers.getContractFactory("DurationDonation");
        const v2Impl = await V2.deploy();
        await v2Impl.waitForDeployment();

        const tokenAddr = await token.getAddress();
        const perTxCap = ethers.parseEther("500.0");
        const dailyCap = ethers.parseEther("2500.0");

        const initData = donation.interface.encodeFunctionData("initializeV2", [
          [tokenAddr, ethers.ZeroAddress],
          [
            [true, perTxCap, dailyCap, 0n, 0n],
            [true, perTxCap, dailyCap, 0n, 0n],
          ],
        ]);

        await expect(
          donation.upgradeToAndCall(await v2Impl.getAddress(), initData),
        ).to.emit(donation, "Upgraded");

        const tokenCfg = await donation.tokenConfigs(tokenAddr);
        expect(tokenCfg.enabled).to.equal(true);
        expect(tokenCfg.perTxCap).to.equal(perTxCap);
        expect(tokenCfg.dailyCap).to.equal(dailyCap);

        const nativeCfg = await donation.tokenConfigs(ethers.ZeroAddress);
        expect(nativeCfg.enabled).to.equal(true);
        expect(nativeCfg.dailyCap).to.equal(dailyCap);
      });

      it("Should not re-run initializeV2 (single-shot reinitializer)", async () => {
        const tokenAddr = await token.getAddress();
        await donation.initializeV2(
          [tokenAddr],
          [[true, ethers.parseEther("500.0"), ethers.parseEther("2500.0"), 0n, 0n]],
        );

        await expect(
          donation.initializeV2(
            [tokenAddr],
            [[true, ethers.parseEther("500.0"), ethers.parseEther("2500.0"), 0n, 0n]],
          ),
        ).to.be.revertedWithCustomError(donation, "InvalidInitialization");
      });
    });
  });

  describe("Pausing", () => {
    beforeEach(async () => {
      await token.connect(donor).approve(await donation.getAddress(), ethers.parseEther("1000.0"));
    });

    it("Should allow owner to pause the contract", async () => {
      await donation.pause();
      expect(await donation.paused()).to.equal(true);
    });

    it("Should allow owner to unpause the contract", async () => {
      await donation.pause();
      await donation.unpause();
      expect(await donation.paused()).to.equal(false);
    });

    it("Should prevent ERC20 donations when paused", async () => {
      await donation.pause();

      await expect(
        donation.connect(donor).processDonation(
          charity.address,
          await token.getAddress(),
          ethers.parseEther("10.0"),
          0n
        )
      ).to.be.revertedWithCustomError(donation, "EnforcedPause");
    });

    it("Should prevent native donations when paused", async () => {
      await donation.pause();

      await expect(
        donation.connect(donor).donateNative(charity.address, 0n, {
          value: ethers.parseEther("1.0"),
        })
      ).to.be.revertedWithCustomError(donation, "EnforcedPause");
    });

    it("Should not allow non-owner to pause", async () => {
      await expect(
        donation.connect(donor).pause()
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
    });

    it("Should not allow non-owner to unpause", async () => {
      await donation.pause();

      await expect(
        donation.connect(donor).unpause()
      ).to.be.revertedWithCustomError(donation, "OwnableUnauthorizedAccount");
    });
  });

  describe("View Functions", () => {
    it("Should return correct charity info", async () => {
      const charityInfo = await donation.getCharityInfo(charity.address);

      expect(charityInfo.isRegistered).to.equal(true);
      expect(charityInfo.walletAddress).to.equal(charity.address);
      expect(charityInfo.totalReceived).to.equal(0);
      expect(charityInfo.isActive).to.equal(true);
    });

    it("Should return zero for unregistered charity", async () => {
      const charityInfo = await donation.getCharityInfo(nonOwner.address);

      expect(charityInfo.isRegistered).to.equal(false);
      expect(charityInfo.totalReceived).to.equal(0);
    });

    it("Should return correct donation amount", async () => {
      const donationAmount = await donation.getDonationAmount(donor.address, charity.address);
      expect(donationAmount).to.equal(0);
    });
  });

  describe("Upgradeability", () => {
    it("Should not allow initialize to be called twice", async () => {
      await expect(
        donation.initialize(treasury.address, owner.address),
      ).to.be.revertedWithCustomError(donation, "InvalidInitialization");
    });

    it("Should allow owner to upgrade", async () => {
      const V2 = await ethers.getContractFactory("DurationDonation");
      const upgraded = await hre.upgrades.upgradeProxy(
        await donation.getAddress(),
        V2,
        { kind: "uups" },
      );
      expect(await upgraded.getAddress()).to.equal(
        await donation.getAddress(),
      );
    });

    it("Should reject unauthorized upgrade", async () => {
      const V2 = await ethers.getContractFactory(
        "DurationDonation",
        nonOwner,
      );
      await expect(
        hre.upgrades.upgradeProxy(await donation.getAddress(), V2, {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(
        donation,
        "OwnableUnauthorizedAccount",
      );
    });

    it("Should preserve state across upgrade", async () => {
      // Verify initial state
      const charityInfoBefore = await donation.getCharityInfo(charity.address);
      expect(charityInfoBefore.isRegistered).to.equal(true);

      // Upgrade
      const V2 = await ethers.getContractFactory("DurationDonation");
      const upgraded = await hre.upgrades.upgradeProxy(
        await donation.getAddress(),
        V2,
        { kind: "uups" },
      );

      // Verify state preserved
      const charityInfoAfter = await upgraded.getCharityInfo(charity.address);
      expect(charityInfoAfter.isRegistered).to.equal(true);
      expect(charityInfoAfter.isActive).to.equal(true);

      // Verify treasury preserved
      expect(await upgraded.giveProtocolTreasury()).to.equal(treasury.address);

      // Verify tip rates preserved
      const rates = await upgraded.getSuggestedTipRates();
      expect(rates.length).to.equal(3);
      expect(rates[0]).to.equal(500n);
    });

    it("Should keep same proxy address after upgrade", async () => {
      const proxyAddr = await donation.getAddress();
      const V2 = await ethers.getContractFactory("DurationDonation");
      const upgraded = await hre.upgrades.upgradeProxy(proxyAddr, V2, {
        kind: "uups",
      });
      expect(await upgraded.getAddress()).to.equal(proxyAddr);
    });

    it("Should emit Upgraded event with new implementation address", async () => {
      const V2 = await ethers.getContractFactory("DurationDonation");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const v2Addr = await v2Impl.getAddress();

      await expect(donation.upgradeToAndCall(v2Addr, "0x"))
        .to.emit(donation, "Upgraded")
        .withArgs(v2Addr);
    });
  });
});
