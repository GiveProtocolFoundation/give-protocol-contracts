const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

/**
 * Storage Layout Validation Tests
 *
 * These tests verify that state variables occupy the expected storage slots
 * in each upgradeable contract. If a future upgrade accidentally reorders
 * or inserts variables, these tests will fail — catching storage collision
 * before it reaches a deployed proxy.
 *
 * OZ upgradeable base contracts occupy slots before the contract's own
 * variables. The slot numbers below refer to the contract-level variables
 * only (their position in the Solidity source order).
 *
 * Approach: write a known value, then read it back via eth_getStorageAt
 * at the slot we expect. Mappings are verified by computing the Solidity
 * storage key (keccak256(abi.encode(key, slot))).
 */

// Helper: read a raw storage slot from a proxy address
function readSlot(proxyAddr, slot) {
  return ethers.provider.getStorage(proxyAddr, slot);
}

// Helper: compute Solidity mapping slot for mapping(address => X) at baseSlot
function mappingSlot(key, baseSlot) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [key, baseSlot],
    ),
  );
}

// Helper: compute Solidity mapping slot for mapping(bytes32 => X) at baseSlot
function mappingSlotBytes32(key, baseSlot) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256"],
      [key, baseSlot],
    ),
  );
}

// OZ Initializable + OwnableUpgradeable + ReentrancyGuardUpgradeable +
// PausableUpgradeable + UUPSUpgradeable occupy implementation-specific
// slots via ERC-7201 namespaced storage in OZ v5. Contract-level state
// variables start at slot 0 as declared in Solidity source.

describe("StorageLayout", () => {

  // ────────────────────────────────────────────────
  // DurationDonation
  // Slot 0: giveProtocolTreasury (address)
  // Slot 1: charities mapping(address => Charity)
  // Slot 2: donations mapping(address => mapping(address => uint256))
  // Slot 3: taxReceipts mapping(bytes32 => TaxReceipt)
  // Slot 4: suggestedTipRates (uint256[] — dynamic array)
  // Slot 5: platformFeeRate (uint256)
  // Slot 6: tokenConfigs mapping(address => TokenConfig)
  // Slots 7–55: __gap
  // ────────────────────────────────────────────────
  describe("DurationDonation", () => {
    let donation = null, proxyAddr = null;
    let owner = null, treasury = null, charity = null;

    beforeEach(async () => {
      [owner, treasury, charity] = await ethers.getSigners();
      const DurationDonation = await ethers.getContractFactory("DurationDonation");
      donation = await hre.upgrades.deployProxy(
        DurationDonation,
        [treasury.address, owner.address],
        { initializer: "initialize", kind: "uups" },
      );
      await donation.waitForDeployment();
      proxyAddr = await donation.getAddress();
    });

    it("Slot 0: giveProtocolTreasury", async () => {
      const raw = await readSlot(proxyAddr, 0);
      const addr = ethers.getAddress(`0x${raw.slice(26)}`); // last 20 bytes
      expect(addr).to.equal(treasury.address);
    });

    it("Slot 1: charities mapping — registered charity has isRegistered=true", async () => {
      await donation.registerCharity(charity.address);
      // Charity struct: { bool isRegistered, address walletAddress, uint256 totalReceived, bool isActive }
      // First field (isRegistered) at mappingSlot(charity, 1) + 0
      const slot = mappingSlot(charity.address, 1);
      const raw = await readSlot(proxyAddr, slot);
      // isRegistered is packed with walletAddress in the first 32-byte word
      // bool(1 byte) + address(20 bytes) fit in one slot
      expect(raw).to.not.equal(ethers.ZeroHash); // non-zero means populated
    });

    it("Slot 4: suggestedTipRates array length = 3", async () => {
      const raw = await readSlot(proxyAddr, 4);
      expect(BigInt(raw)).to.equal(3n); // initialized with 3 tip rates
    });

    it("Slot 5: platformFeeRate = 100", async () => {
      const raw = await readSlot(proxyAddr, 5);
      expect(BigInt(raw)).to.equal(100n);
    });

    it("Slot 6: tokenConfigs mapping — enabled token has populated config", async () => {
      await donation.setTokenConfig(treasury.address, true, ethers.parseEther("500"), ethers.parseEther("2500"));
      const baseSlot = mappingSlot(treasury.address, 6);
      // TokenConfig: { bool enabled, uint256 perTxCap, uint256 dailyCap, uint256 dailyWindowStart, uint256 dailyVolume }
      const enabledRaw = await readSlot(proxyAddr, baseSlot);
      expect(BigInt(enabledRaw)).to.equal(1n); // enabled=true packed in the low byte

      const perTxRaw = await readSlot(proxyAddr, BigInt(baseSlot) + 1n);
      expect(BigInt(perTxRaw)).to.equal(ethers.parseEther("500"));

      const dailyRaw = await readSlot(proxyAddr, BigInt(baseSlot) + 2n);
      expect(BigInt(dailyRaw)).to.equal(ethers.parseEther("2500"));
    });

    it("Slots 7–55: __gap is zeroed", async () => {
      // Spot-check first, middle, and last gap slots
      for (const slot of [7, 30, 55]) {
        const raw = await readSlot(proxyAddr, slot);
        expect(raw).to.equal(ethers.ZeroHash);
      }
    });
  });

  // ────────────────────────────────────────────────
  // CharityScheduledDistribution
  // Slot 0: donationSchedules mapping(uint256 => DonationSchedule)
  // Slot 1: nextScheduleId (uint256)
  // Slot 2: tokenPrices mapping(address => uint256)
  // Slot 3: verifiedCharities mapping(address => bool)
  // Slot 4: treasury (address)
  // Slot 5: platformFeeRate (uint256)
  // Slots 6–55: __gap
  // ────────────────────────────────────────────────
  describe("CharityScheduledDistribution", () => {
    let distribution = null, proxyAddr = null;
    let owner = null, treasury = null, charity = null;

    beforeEach(async () => {
      [owner, treasury, charity] = await ethers.getSigners();
      const CSD = await ethers.getContractFactory("CharityScheduledDistribution");
      distribution = await hre.upgrades.deployProxy(
        CSD,
        [treasury.address, owner.address],
        { initializer: "initialize", kind: "uups" },
      );
      await distribution.waitForDeployment();
      proxyAddr = await distribution.getAddress();
    });

    it("Slot 1: nextScheduleId = 0 initially", async () => {
      const raw = await readSlot(proxyAddr, 1);
      expect(BigInt(raw)).to.equal(0n);
    });

    it("Slot 3: verifiedCharities mapping — added charity", async () => {
      await distribution.addCharity(charity.address);
      const slot = mappingSlot(charity.address, 3);
      const raw = await readSlot(proxyAddr, slot);
      expect(BigInt(raw)).to.equal(1n); // true
    });

    it("Slot 4: treasury address", async () => {
      const raw = await readSlot(proxyAddr, 4);
      const addr = ethers.getAddress(`0x${raw.slice(26)}`);
      expect(addr).to.equal(treasury.address);
    });

    it("Slot 5: platformFeeRate = 100", async () => {
      const raw = await readSlot(proxyAddr, 5);
      expect(BigInt(raw)).to.equal(100n);
    });

    it("Slots 6–55: __gap is zeroed", async () => {
      for (const slot of [6, 30, 55]) {
        const raw = await readSlot(proxyAddr, slot);
        expect(raw).to.equal(ethers.ZeroHash);
      }
    });
  });

  // ────────────────────────────────────────────────
  // PortfolioFunds (AccessControl-based)
  // Slot 0: portfolioFunds mapping(bytes32 => PortfolioFund)
  // Slot 1: activeFundIds bytes32[]
  // Slot 2: verifiedCharities mapping(address => bool)
  // Slot 3: charityNames mapping(address => string)
  // Slot 4: charityToFunds mapping(address => bytes32[])
  // Slot 5: treasury (address)
  // Slot 6: platformFeeRate (uint256)
  // Slot 7: governanceActive (bool)
  // Slots 8–57: __gap
  // ────────────────────────────────────────────────
  describe("PortfolioFunds", () => {
    let portfolioFunds = null, proxyAddr = null;
    let owner = null, treasury = null, charity1 = null;

    beforeEach(async () => {
      [owner, treasury, charity1] = await ethers.getSigners();
      const PF = await ethers.getContractFactory("PortfolioFunds");
      portfolioFunds = await hre.upgrades.deployProxy(
        PF,
        [treasury.address, owner.address],
        { initializer: "initialize", kind: "uups" },
      );
      await portfolioFunds.waitForDeployment();
      proxyAddr = await portfolioFunds.getAddress();
    });

    it("Slot 1: activeFundIds array length = 0 initially", async () => {
      const raw = await readSlot(proxyAddr, 1);
      expect(BigInt(raw)).to.equal(0n);
    });

    it("Slot 2: verifiedCharities mapping — added charity", async () => {
      await portfolioFunds.addVerifiedCharity(charity1.address, "Test Charity");
      const slot = mappingSlot(charity1.address, 2);
      const raw = await readSlot(proxyAddr, slot);
      expect(BigInt(raw)).to.equal(1n); // true
    });

    it("Slot 5: treasury address", async () => {
      const raw = await readSlot(proxyAddr, 5);
      const addr = ethers.getAddress(`0x${raw.slice(26)}`);
      expect(addr).to.equal(treasury.address);
    });

    it("Slot 6: platformFeeRate = 100", async () => {
      const raw = await readSlot(proxyAddr, 6);
      expect(BigInt(raw)).to.equal(100n);
    });

    it("Slot 7: governanceActive = false initially", async () => {
      const raw = await readSlot(proxyAddr, 7);
      expect(BigInt(raw)).to.equal(0n);
    });

    it("Slot 7: governanceActive = true after activation", async () => {
      await portfolioFunds.activateGovernance();
      const raw = await readSlot(proxyAddr, 7);
      expect(BigInt(raw)).to.equal(1n);
    });

    it("Slots 8–57: __gap is zeroed", async () => {
      for (const slot of [8, 32, 57]) {
        const raw = await readSlot(proxyAddr, slot);
        expect(raw).to.equal(ethers.ZeroHash);
      }
    });
  });

  // ────────────────────────────────────────────────
  // VolunteerVerification
  // Slot 0: charities mapping(address => Charity)
  // Slot 1: applications mapping(bytes32 => VolunteerApplication)
  // Slot 2: volunteerHours mapping(bytes32 => VolunteerHours)
  // Slots 3–52: __gap
  // ────────────────────────────────────────────────
  describe("VolunteerVerification", () => {
    let verification = null, proxyAddr = null;
    let owner = null, charity = null, applicant = null;

    beforeEach(async () => {
      [owner, charity, applicant] = await ethers.getSigners();
      const VV = await ethers.getContractFactory("VolunteerVerification");
      verification = await hre.upgrades.deployProxy(
        VV,
        [owner.address],
        { initializer: "initialize", kind: "uups" },
      );
      await verification.waitForDeployment();
      proxyAddr = await verification.getAddress();
    });

    it("Slot 0: charities mapping — registered charity", async () => {
      await verification.registerCharity(charity.address);
      const slot = mappingSlot(charity.address, 0);
      const raw = await readSlot(proxyAddr, slot);
      expect(raw).to.not.equal(ethers.ZeroHash); // populated struct
    });

    it("Slot 1: applications mapping — verified application", async () => {
      await verification.registerCharity(charity.address);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("storage-test-app"));
      await verification.connect(charity).verifyApplication(hash, applicant.address);
      const slot = mappingSlotBytes32(hash, 1);
      const raw = await readSlot(proxyAddr, slot);
      expect(raw).to.not.equal(ethers.ZeroHash); // populated struct
    });

    it("Slots 3–52: __gap is zeroed", async () => {
      for (const slot of [3, 27, 52]) {
        const raw = await readSlot(proxyAddr, slot);
        expect(raw).to.equal(ethers.ZeroHash);
      }
    });
  });

  // ────────────────────────────────────────────────
  // FiatDonationAttestation (AccessControl-based)
  // Slot 0: attestations mapping(bytes32 => FiatAttestation)
  // Slot 1: processedRefHashes mapping(bytes32 => bool)
  // Slot 2: charities mapping(address => Charity)
  // Slot 3: totalAttestedByCharity mapping(address => mapping(bytes3 => uint256))
  // Slot 4: attestationCount (uint256)
  // Slot 5: canonicalChainId (uint256)
  // Slots 6–55: __gap
  // ────────────────────────────────────────────────
  describe("FiatDonationAttestation", () => {
    let attestation = null, proxyAddr = null;
    let admin = null, attester = null, charity1 = null;

    const HARDHAT_CHAIN_ID = 31337n;
    const USD = ethers.encodeBytes32String("USD").slice(0, 8);

    beforeEach(async () => {
      [admin, attester, charity1] = await ethers.getSigners();
      const FDA = await ethers.getContractFactory("FiatDonationAttestation");
      attestation = await hre.upgrades.deployProxy(
        FDA,
        [HARDHAT_CHAIN_ID, admin.address],
        { initializer: "initialize", kind: "uups" },
      );
      await attestation.waitForDeployment();
      proxyAddr = await attestation.getAddress();

      const ATTESTER_ROLE = await attestation.ATTESTER_ROLE();
      await attestation.grantRole(ATTESTER_ROLE, attester.address);
    });

    it("Slot 4: attestationCount = 0 initially", async () => {
      const raw = await readSlot(proxyAddr, 4);
      expect(BigInt(raw)).to.equal(0n);
    });

    it("Slot 4: attestationCount increments after attestation", async () => {
      await attestation.registerCharity(charity1.address);
      const ref = ethers.keccak256(ethers.toUtf8Bytes("storage-test-ref"));
      await attestation.connect(attester).attest(charity1.address, 5000, USD, ref);
      const raw = await readSlot(proxyAddr, 4);
      expect(BigInt(raw)).to.equal(1n);
    });

    it("Slot 5: canonicalChainId = 31337", async () => {
      const raw = await readSlot(proxyAddr, 5);
      expect(BigInt(raw)).to.equal(HARDHAT_CHAIN_ID);
    });

    it("Slot 1: processedRefHashes mapping — processed ref", async () => {
      await attestation.registerCharity(charity1.address);
      const ref = ethers.keccak256(ethers.toUtf8Bytes("storage-ref-check"));
      await attestation.connect(attester).attest(charity1.address, 5000, USD, ref);
      const slot = mappingSlotBytes32(ref, 1);
      const raw = await readSlot(proxyAddr, slot);
      expect(BigInt(raw)).to.equal(1n); // true
    });

    it("Slots 6–55: __gap is zeroed", async () => {
      for (const slot of [6, 30, 55]) {
        const raw = await readSlot(proxyAddr, slot);
        expect(raw).to.equal(ethers.ZeroHash);
      }
    });
  });
});
