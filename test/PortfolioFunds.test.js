const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("PortfolioFunds", () => {
  let portfolioFunds = null;
  let token = null;
  let owner = null;
  let treasury = null;
  let charity1 = null;
  let charity2 = null;
  let charity3 = null;
  let donor = null;
  let nonAdmin = null;

  const FEE_RATE = 50n; // 0.5% in basis points
  const BASIS_POINTS = 10000n;

  // Helper function to setup charities
  async function setupCharities(count = 2) {
    const charities = [charity1, charity2, charity3].slice(0, count);
    const names = ["Charity One", "Charity Two", "Charity Three"].slice(0, count);
    for (let i = 0; i < count; i++) {
      await portfolioFunds.addVerifiedCharity(charities[i].address, names[i]);
    }
    return { charities: charities.map(c => c.address), names };
  }

  // Helper function to create a fund and return its ID
  async function createFundAndGetId(charityCount = 2) {
    const { charities, names } = await setupCharities(charityCount);
    await portfolioFunds.createPortfolioFund("Test Fund", "A test portfolio fund", charities, names);
    const activeFunds = await portfolioFunds.getAllActiveFunds();
    return activeFunds[0];
  }

  // Helper function to setup fund with token approval
  async function setupFundWithTokenApproval(charityCount = 2, approvalAmount = "1000.0") {
    const fundId = await createFundAndGetId(charityCount);
    await token.connect(donor).approve(await portfolioFunds.getAddress(), ethers.parseEther(approvalAmount));
    return fundId;
  }

  beforeEach(async () => {
    [owner, treasury, charity1, charity2, charity3, donor, nonAdmin] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("Mock Token", "MTK");
    await token.mint(donor.address, ethers.parseEther("1000.0"));

    const PortfolioFunds = await ethers.getContractFactory("PortfolioFunds");
    portfolioFunds = await hre.upgrades.deployProxy(
      PortfolioFunds,
      [treasury.address, owner.address],
      { initializer: "initialize", kind: "uups" },
    );
    await portfolioFunds.waitForDeployment();
  });

  describe("Deployment", () => {
    it("Should set the correct treasury address", async () => {
      expect(await portfolioFunds.treasury()).to.equal(treasury.address);
    });

    it("Should set the correct platform fee rate", async () => {
      expect(await portfolioFunds.platformFeeRate()).to.equal(FEE_RATE);
    });

    it("Should grant admin role to deployer", async () => {
      const ADMIN_ROLE = await portfolioFunds.ADMIN_ROLE();
      expect(await portfolioFunds.hasRole(ADMIN_ROLE, owner.address)).to.equal(true);
    });

    it("Should revert with zero treasury address", async () => {
      const PortfolioFunds = await ethers.getContractFactory("PortfolioFunds");
      await expect(
        hre.upgrades.deployProxy(
          PortfolioFunds,
          [ethers.ZeroAddress, owner.address],
          { initializer: "initialize", kind: "uups" },
        ),
      ).to.be.revertedWith("Invalid treasury address");
    });
  });

  describe("Charity Management", () => {
    it("Should allow admin to add verified charity", async () => {
      await expect(portfolioFunds.addVerifiedCharity(charity1.address, "Charity One"))
        .to.emit(portfolioFunds, "CharityVerified")
        .withArgs(charity1.address, "Charity One");

      expect(await portfolioFunds.verifiedCharities(charity1.address)).to.equal(true);
      expect(await portfolioFunds.charityNames(charity1.address)).to.equal("Charity One");
    });

    it("Should not allow non-admin to add verified charity", async () => {
      await expect(
        portfolioFunds.connect(nonAdmin).addVerifiedCharity(charity1.address, "Charity One")
      ).to.be.reverted;
    });

    it("Should not allow adding charity with zero address", async () => {
      await expect(
        portfolioFunds.addVerifiedCharity(ethers.ZeroAddress, "Invalid")
      ).to.be.revertedWith("Invalid charity address");
    });

    it("Should not allow adding charity with empty name", async () => {
      await expect(
        portfolioFunds.addVerifiedCharity(charity1.address, "")
      ).to.be.revertedWith("Name cannot be empty");
    });

    it("Should allow admin to remove verified charity", async () => {
      await portfolioFunds.addVerifiedCharity(charity1.address, "Charity One");
      await expect(portfolioFunds.removeVerifiedCharity(charity1.address))
        .to.emit(portfolioFunds, "CharityUnverified")
        .withArgs(charity1.address);
      expect(await portfolioFunds.verifiedCharities(charity1.address)).to.equal(false);
    });
  });

  describe("Fund Creation", () => {
    beforeEach(async () => {
      await setupCharities(3);
    });

    it("Should create a portfolio fund with equal distribution", async () => {
      const tx = await portfolioFunds.createPortfolioFund(
        "Test Fund", "A test portfolio fund",
        [charity1.address, charity2.address], ["Charity One", "Charity Two"]
      );
      await expect(tx).to.emit(portfolioFunds, "FundCreated");

      const activeFunds = await portfolioFunds.getAllActiveFunds();
      expect(activeFunds.length).to.equal(1);

      const fundDetails = await portfolioFunds.getFundDetails(activeFunds[0]);
      expect(fundDetails.name).to.equal("Test Fund");
      expect(fundDetails.active).to.equal(true);
      expect(fundDetails.ratios[0]).to.equal(5000n);
      expect(fundDetails.ratios[1]).to.equal(5000n);
    });

    it("Should create fund with 3 charities and handle remainder", async () => {
      await portfolioFunds.createPortfolioFund(
        "Three Charity Fund", "Fund with three charities",
        [charity1.address, charity2.address, charity3.address],
        ["Charity One", "Charity Two", "Charity Three"]
      );

      const activeFunds = await portfolioFunds.getAllActiveFunds();
      const fundDetails = await portfolioFunds.getFundDetails(activeFunds[0]);
      expect(fundDetails.ratios[0]).to.equal(3334n);
      expect(fundDetails.ratios[1]).to.equal(3333n);
      expect(fundDetails.ratios[2]).to.equal(3333n);
    });

    it("Should not allow non-admin to create fund", async () => {
      await expect(
        portfolioFunds.connect(nonAdmin).createPortfolioFund(
          "Test Fund", "Description", [charity1.address], ["Charity One"]
        )
      ).to.be.reverted;
    });

    it("Should not create fund with unverified charity", async () => {
      await expect(
        portfolioFunds.createPortfolioFund("Test Fund", "Description", [nonAdmin.address], ["Unknown"])
      ).to.be.revertedWith("Charity not verified");
    });

    it("Should not create fund with zero charities", async () => {
      await expect(
        portfolioFunds.createPortfolioFund("Test Fund", "Description", [], [])
      ).to.be.revertedWith("Invalid charity count");
    });

    it("Should not create fund with mismatched arrays", async () => {
      await expect(
        portfolioFunds.createPortfolioFund(
          "Test Fund", "Description", [charity1.address, charity2.address], ["Charity One"]
        )
      ).to.be.revertedWith("Array length mismatch");
    });

    it("Should not create fund with duplicate charities", async () => {
      await expect(
        portfolioFunds.createPortfolioFund(
          "Test Fund", "Description", [charity1.address, charity1.address], ["Charity One", "Dup"]
        )
      ).to.be.revertedWith("Duplicate charity");
    });
  });

  describe("ERC20 Token Donations", () => {
    let fundId = null;

    beforeEach(async () => {
      fundId = await setupFundWithTokenApproval();
    });

    it("Should process ERC20 donation with fee", async () => {
      const donationAmount = ethers.parseEther("100.0");
      const expectedFee = (donationAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNet = donationAmount - expectedFee;
      const treasuryBalanceBefore = await token.balanceOf(treasury.address);

      await expect(
        portfolioFunds.connect(donor).donateToFund(fundId, await token.getAddress(), donationAmount)
      ).to.emit(portfolioFunds, "DonationReceived")
        .withArgs(fundId, donor.address, await token.getAddress(), donationAmount, expectedFee, expectedNet);

      expect(await token.balanceOf(treasury.address) - treasuryBalanceBefore).to.equal(expectedFee);
      expect(await portfolioFunds.getFundBalance(fundId, await token.getAddress())).to.equal(expectedNet);
    });

    it("Should not allow donation to inactive fund", async () => {
      await portfolioFunds.pauseFund(fundId);
      await expect(
        portfolioFunds.connect(donor).donateToFund(fundId, await token.getAddress(), ethers.parseEther("10.0"))
      ).to.be.revertedWith("Fund not active");
    });

    it("Should not allow zero amount donation", async () => {
      await expect(
        portfolioFunds.connect(donor).donateToFund(fundId, await token.getAddress(), 0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should not allow donation with zero token address", async () => {
      await expect(
        portfolioFunds.connect(donor).donateToFund(fundId, ethers.ZeroAddress, ethers.parseEther("10.0"))
      ).to.be.revertedWith("Invalid token address");
    });
  });

  describe("Native Token Donations", () => {
    let fundId = null;

    beforeEach(async () => {
      fundId = await createFundAndGetId();
    });

    it("Should process native token donation with fee", async () => {
      const donationAmount = ethers.parseEther("1.0");
      const expectedFee = (donationAmount * FEE_RATE) / BASIS_POINTS;
      const expectedNet = donationAmount - expectedFee;
      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

      await expect(
        portfolioFunds.connect(donor).donateNativeToFund(fundId, { value: donationAmount })
      ).to.emit(portfolioFunds, "DonationReceived")
        .withArgs(fundId, donor.address, ethers.ZeroAddress, donationAmount, expectedFee, expectedNet);

      expect(await ethers.provider.getBalance(treasury.address) - treasuryBalanceBefore).to.equal(expectedFee);
      expect(await portfolioFunds.getFundBalance(fundId, ethers.ZeroAddress)).to.equal(expectedNet);
    });

    it("Should not allow zero value native donation", async () => {
      await expect(
        portfolioFunds.connect(donor).donateNativeToFund(fundId, { value: 0 })
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should not allow native donation to inactive fund", async () => {
      await portfolioFunds.pauseFund(fundId);
      await expect(
        portfolioFunds.connect(donor).donateNativeToFund(fundId, { value: ethers.parseEther("1.0") })
      ).to.be.revertedWith("Fund not active");
    });
  });

  describe("Claiming Funds", () => {
    let fundId = null;

    beforeEach(async () => {
      fundId = await setupFundWithTokenApproval(2, "100.0");
      await portfolioFunds.connect(donor).donateToFund(fundId, await token.getAddress(), ethers.parseEther("100.0"));
    });

    it("Should allow charity to claim ERC20 funds", async () => {
      const tokenAddress = await token.getAddress();
      const claimableAmount = await portfolioFunds.getCharityClaimableAmount(fundId, charity1.address, tokenAddress);
      expect(claimableAmount).to.be.gt(0);

      const balanceBefore = await token.balanceOf(charity1.address);
      await expect(portfolioFunds.connect(charity1).claimFunds(fundId, tokenAddress))
        .to.emit(portfolioFunds, "CharityClaimedFunds");

      expect(await token.balanceOf(charity1.address) - balanceBefore).to.equal(claimableAmount);
      expect(await portfolioFunds.getCharityClaimableAmount(fundId, charity1.address, tokenAddress)).to.equal(0);
      expect(await portfolioFunds.getCharityTotalClaimed(fundId, charity1.address, tokenAddress)).to.equal(claimableAmount);
    });

    it("Should allow charity to claim native funds", async () => {
      await portfolioFunds.connect(donor).donateNativeToFund(fundId, { value: ethers.parseEther("1.0") });
      const claimableAmount = await portfolioFunds.getCharityClaimableAmount(fundId, charity1.address, ethers.ZeroAddress);
      expect(claimableAmount).to.be.gt(0);

      const balanceBefore = await ethers.provider.getBalance(charity1.address);
      const tx = await portfolioFunds.connect(charity1).claimFunds(fundId, ethers.ZeroAddress);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      expect(await ethers.provider.getBalance(charity1.address) - balanceBefore + gasUsed).to.equal(claimableAmount);
    });

    it("Should not allow non-charity to claim funds", async () => {
      await expect(
        portfolioFunds.connect(donor).claimFunds(fundId, await token.getAddress())
      ).to.be.revertedWith("Not authorized charity for this fund");
    });

    it("Should not allow claiming with no funds", async () => {
      await portfolioFunds.connect(charity1).claimFunds(fundId, await token.getAddress());
      await expect(
        portfolioFunds.connect(charity1).claimFunds(fundId, await token.getAddress())
      ).to.be.revertedWith("No funds to claim");
    });

    it("Should not allow claiming from inactive fund", async () => {
      await portfolioFunds.pauseFund(fundId);
      await expect(
        portfolioFunds.connect(charity1).claimFunds(fundId, await token.getAddress())
      ).to.be.revertedWith("Fund not active");
    });
  });

  describe("Batch Claiming", () => {
    let fundId = null;
    let token2 = null;

    beforeEach(async () => {
      fundId = await setupFundWithTokenApproval(2, "100.0");

      const MockToken = await ethers.getContractFactory("MockERC20");
      token2 = await MockToken.deploy("Mock Token 2", "MTK2");
      await token2.mint(donor.address, ethers.parseEther("1000.0"));
      await token2.connect(donor).approve(await portfolioFunds.getAddress(), ethers.parseEther("100.0"));

      await portfolioFunds.connect(donor).donateToFund(fundId, await token.getAddress(), ethers.parseEther("100.0"));
      await portfolioFunds.connect(donor).donateToFund(fundId, await token2.getAddress(), ethers.parseEther("50.0"));
    });

    it("Should allow batch claiming multiple tokens", async () => {
      const tokens = [await token.getAddress(), await token2.getAddress()];
      const claimable1 = await portfolioFunds.getCharityClaimableAmount(fundId, charity1.address, tokens[0]);
      const claimable2 = await portfolioFunds.getCharityClaimableAmount(fundId, charity1.address, tokens[1]);

      const balance1Before = await token.balanceOf(charity1.address);
      const balance2Before = await token2.balanceOf(charity1.address);

      await portfolioFunds.connect(charity1).claimMultipleTokens(fundId, tokens);

      expect(await token.balanceOf(charity1.address) - balance1Before).to.equal(claimable1);
      expect(await token2.balanceOf(charity1.address) - balance2Before).to.equal(claimable2);
    });

    it("Should not allow batch claiming with empty array", async () => {
      await expect(
        portfolioFunds.connect(charity1).claimMultipleTokens(fundId, [])
      ).to.be.revertedWith("Invalid token count");
    });
  });

  describe("Governance", () => {
    let fundId = null;

    beforeEach(async () => {
      fundId = await createFundAndGetId();
    });

    it("Should not allow updating ratios before governance is activated", async () => {
      await expect(
        portfolioFunds.updateDistributionRatios(fundId, [6000n, 4000n])
      ).to.be.revertedWith("Governance not yet activated");
    });

    it("Should allow activating governance", async () => {
      await expect(portfolioFunds.activateGovernance()).to.emit(portfolioFunds, "GovernanceActivated");
      expect(await portfolioFunds.governanceActive()).to.equal(true);
    });

    it("Should not allow activating governance twice", async () => {
      await portfolioFunds.activateGovernance();
      await expect(portfolioFunds.activateGovernance()).to.be.revertedWith("Governance already active");
    });

    it("Should allow updating ratios after governance is activated", async () => {
      await portfolioFunds.activateGovernance();
      await expect(portfolioFunds.updateDistributionRatios(fundId, [6000n, 4000n]))
        .to.emit(portfolioFunds, "DistributionRatiosUpdated");

      const fundDetails = await portfolioFunds.getFundDetails(fundId);
      expect(fundDetails.ratios[0]).to.equal(6000n);
      expect(fundDetails.ratios[1]).to.equal(4000n);
    });

    it("Should not allow ratios that don't sum to 100%", async () => {
      await portfolioFunds.activateGovernance();
      await expect(
        portfolioFunds.updateDistributionRatios(fundId, [5000n, 4000n])
      ).to.be.revertedWith("Ratios must sum to 100%");
    });

    it("Should not allow zero ratios", async () => {
      await portfolioFunds.activateGovernance();
      await expect(
        portfolioFunds.updateDistributionRatios(fundId, [10000n, 0n])
      ).to.be.revertedWith("Ratio cannot be zero");
    });

    it("Should not allow wrong number of ratios", async () => {
      await portfolioFunds.activateGovernance();
      await expect(
        portfolioFunds.updateDistributionRatios(fundId, [10000n])
      ).to.be.revertedWith("Invalid ratios length");
    });
  });

  describe("Admin Functions", () => {
    it("Should allow admin to update platform fee rate", async () => {
      await expect(portfolioFunds.updatePlatformFeeRate(200n))
        .to.emit(portfolioFunds, "PlatformFeeUpdated").withArgs(200n);
      expect(await portfolioFunds.platformFeeRate()).to.equal(200n);
    });

    it("Should not allow fee rate above 5%", async () => {
      await expect(portfolioFunds.updatePlatformFeeRate(501n)).to.be.revertedWith("Fee cannot exceed 5%");
    });

    it("Should allow admin to update treasury", async () => {
      await expect(portfolioFunds.updateTreasury(nonAdmin.address))
        .to.emit(portfolioFunds, "TreasuryUpdated").withArgs(nonAdmin.address);
      expect(await portfolioFunds.treasury()).to.equal(nonAdmin.address);
    });

    it("Should not allow zero address for treasury", async () => {
      await expect(portfolioFunds.updateTreasury(ethers.ZeroAddress)).to.be.revertedWith("Invalid treasury address");
    });

    it("Should allow admin to pause and unpause fund", async () => {
      const fundId = await createFundAndGetId(1);

      await portfolioFunds.pauseFund(fundId);
      expect((await portfolioFunds.getFundDetails(fundId)).active).to.equal(false);

      await portfolioFunds.unpauseFund(fundId);
      expect((await portfolioFunds.getFundDetails(fundId)).active).to.equal(true);
    });

    it("Should allow admin to emergency pause and unpause", async () => {
      await portfolioFunds.emergencyPause();
      expect(await portfolioFunds.paused()).to.equal(true);

      await portfolioFunds.emergencyUnpause();
      expect(await portfolioFunds.paused()).to.equal(false);
    });
  });

  describe("View Functions", () => {
    let fundId = null;

    beforeEach(async () => {
      fundId = await createFundAndGetId();
    });

    it("Should return correct fund details", async () => {
      const details = await portfolioFunds.getFundDetails(fundId);
      expect(details.name).to.equal("Test Fund");
      expect(details.active).to.equal(true);
      expect(details.charities.length).to.equal(2);
    });

    it("Should return charity funds", async () => {
      const charityFunds = await portfolioFunds.getCharityFunds(charity1.address);
      expect(charityFunds.length).to.equal(1);
      expect(charityFunds[0]).to.equal(fundId);
    });

    it("Should return all active funds", async () => {
      expect((await portfolioFunds.getAllActiveFunds()).length).to.equal(1);
    });
  });

  describe("Emergency Pause", () => {
    let fundId = null;

    beforeEach(async () => {
      fundId = await setupFundWithTokenApproval(1, "100.0");
    });

    it("Should prevent donations when paused", async () => {
      await portfolioFunds.emergencyPause();
      await expect(
        portfolioFunds.connect(donor).donateToFund(fundId, await token.getAddress(), ethers.parseEther("10.0"))
      ).to.be.revertedWithCustomError(portfolioFunds, "EnforcedPause");
    });

    it("Should prevent native donations when paused", async () => {
      await portfolioFunds.emergencyPause();
      await expect(
        portfolioFunds.connect(donor).donateNativeToFund(fundId, { value: ethers.parseEther("1.0") })
      ).to.be.revertedWithCustomError(portfolioFunds, "EnforcedPause");
    });
  });

  describe("Upgradeability", () => {
    it("Should not allow initialize to be called twice", async () => {
      await expect(
        portfolioFunds.initialize(treasury.address, owner.address),
      ).to.be.revertedWithCustomError(portfolioFunds, "InvalidInitialization");
    });

    it("Should allow admin to upgrade", async () => {
      const V2 = await ethers.getContractFactory("PortfolioFunds");
      const upgraded = await hre.upgrades.upgradeProxy(
        await portfolioFunds.getAddress(),
        V2,
        { kind: "uups" },
      );
      expect(await upgraded.getAddress()).to.equal(
        await portfolioFunds.getAddress(),
      );
    });

    it("Should reject unauthorized upgrade", async () => {
      const V2 = await ethers.getContractFactory(
        "PortfolioFunds",
        nonAdmin,
      );
      await expect(
        hre.upgrades.upgradeProxy(await portfolioFunds.getAddress(), V2, {
          kind: "uups",
        }),
      ).to.be.reverted;
    });

    it("Should preserve state across upgrade", async () => {
      // Write state
      await portfolioFunds.addVerifiedCharity(charity1.address, "Charity One");

      // Upgrade
      const V2 = await ethers.getContractFactory("PortfolioFunds");
      const upgraded = await hre.upgrades.upgradeProxy(
        await portfolioFunds.getAddress(),
        V2,
        { kind: "uups" },
      );

      // Verify state preserved
      expect(await upgraded.verifiedCharities(charity1.address)).to.equal(true);
      expect(await upgraded.treasury()).to.equal(treasury.address);
      expect(await upgraded.platformFeeRate()).to.equal(FEE_RATE);
    });

    it("Should keep same proxy address after upgrade", async () => {
      const proxyAddr = await portfolioFunds.getAddress();
      const V2 = await ethers.getContractFactory("PortfolioFunds");
      const upgraded = await hre.upgrades.upgradeProxy(proxyAddr, V2, {
        kind: "uups",
      });
      expect(await upgraded.getAddress()).to.equal(proxyAddr);
    });

    it("Should emit Upgraded event with new implementation address", async () => {
      const V2 = await ethers.getContractFactory("PortfolioFunds");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const v2Addr = await v2Impl.getAddress();

      await expect(portfolioFunds.upgradeToAndCall(v2Addr, "0x"))
        .to.emit(portfolioFunds, "Upgraded")
        .withArgs(v2Addr);
    });

    it("Should preserve fund and charity state across upgrade", async () => {
      // Write fund state
      await portfolioFunds.addVerifiedCharity(charity1.address, "Charity One");
      await portfolioFunds.addVerifiedCharity(charity2.address, "Charity Two");
      await portfolioFunds.createPortfolioFund(
        "Upgrade Test Fund", "Test fund for upgrade",
        [charity1.address, charity2.address], ["Charity One", "Charity Two"],
      );
      const activeFunds = await portfolioFunds.getAllActiveFunds();
      const fundId = activeFunds[0];

      // Donate to create token balances
      await token.connect(donor).approve(await portfolioFunds.getAddress(), ethers.parseEther("100.0"));
      await portfolioFunds.connect(donor).donateToFund(fundId, await token.getAddress(), ethers.parseEther("100.0"));

      // Record pre-upgrade state
      const detailsBefore = await portfolioFunds.getFundDetails(fundId);
      const claimableBefore = await portfolioFunds.getCharityClaimableAmount(fundId, charity1.address, await token.getAddress());

      // Upgrade
      const V2 = await ethers.getContractFactory("PortfolioFunds");
      const upgraded = await hre.upgrades.upgradeProxy(
        await portfolioFunds.getAddress(), V2, { kind: "uups" },
      );

      // Verify all state preserved
      expect(await upgraded.verifiedCharities(charity1.address)).to.equal(true);
      expect(await upgraded.charityNames(charity1.address)).to.equal("Charity One");
      expect(await upgraded.treasury()).to.equal(treasury.address);
      expect(await upgraded.platformFeeRate()).to.equal(FEE_RATE);

      const detailsAfter = await upgraded.getFundDetails(fundId);
      expect(detailsAfter.name).to.equal(detailsBefore.name);
      expect(detailsAfter.active).to.equal(detailsBefore.active);
      expect(detailsAfter.totalRaised).to.equal(detailsBefore.totalRaised);

      const claimableAfter = await upgraded.getCharityClaimableAmount(fundId, charity1.address, await token.getAddress());
      expect(claimableAfter).to.equal(claimableBefore);
    });
  });
});
