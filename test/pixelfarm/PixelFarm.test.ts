import { waffle } from "hardhat";
import { expect } from "chai";

import PixelFarmArtifacts from "../../artifacts/contracts/staking/PixelFarm.sol/PixelFarm.json";
import ERC20MockArtifact from "../../artifacts/contracts/mocks/ERC20Mock.sol/ERC20Mock.json";
import HolopixelArtifact from "../../artifacts/contracts/Holopixel.sol/Holopixel.json";

import { PixelFarm, ERC20Mock, Holopixel } from "../../typechain";
import { Wallet, BigNumber } from "ethers";
import { getBigNumber, latest, advanceTimeAndBlock, latestTimestamp, setNextBlockTimestamp, advanceBlock } from "../utilities";

const { provider, deployContract } = waffle;

const ERR_WITHDRAWING: string = "cannot when withdrawing";
const ERR_UNSTAKE: string = "cannot unstake";
const ERR_UNSTAKE_FIRST: string = "unstake first";

describe("PixelFarm", () => {
  const [deployer, alice, bob, carol, fee] = provider.getWallets() as Wallet[];

  let staking: PixelFarm;
  let token: ERC20Mock;
  let promo: Holopixel;

  const rewardRatePerToken: BigNumber = getBigNumber(250, 11);

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const seven_days = 7 * 24 * 60 * 60;

  beforeEach(async () => {
    token = (await deployContract(deployer, ERC20MockArtifact, ["Test", "Test", 18, getBigNumber(25000000)])) as ERC20Mock;
    promo = (await deployContract(deployer, HolopixelArtifact, [deployer.address])) as Holopixel;
    staking = (await deployContract(deployer, PixelFarmArtifacts, [])) as PixelFarm;

    // init
    await staking.init(token.address, promo.address, fee.address);
    await staking.updatePeriodLength(seven_days);
    await staking.updateTimeToUnstake(seven_days);
    await staking.updateFee(1000);

    // init promo
    await promo.setMinter(staking.address, true);

    // update test account alice balance and allowances
    await token.transfer(alice.address, getBigNumber(1000));
    await token.connect(alice).approve(staking.address, getBigNumber(1000));

    // update test account bob balance and allowances
    await token.transfer(bob.address, getBigNumber(1000));
    await token.connect(bob).approve(staking.address, getBigNumber(1000));

    // update test account carol balance and allowances
    await token.transfer(carol.address, getBigNumber(1000));
    await token.connect(carol).approve(staking.address, getBigNumber(1000));
  });

  describe("Before staking start - when no rewards were added", () => {
    describe("after adding only token stake", () => {
      beforeEach(async () => {
        await staking.connect(alice).addStake(getBigNumber(100));
        await staking.connect(bob).addStake(getBigNumber(100));
        await staking.connect(carol).addStake(getBigNumber(200));
      });

      describe("after adding new rewards", () => {
        beforeEach(async () => {
          await staking.notifyRewardRate(rewardRatePerToken);
        });

        it("tokenStaking data should be in initial state", async () => {
          expect(await staking.rewardRate()).to.be.equal(rewardRatePerToken);
        });

        it("claimable should return token reward amount in first second of staking", async () => {
          const latestBlockTimestamp = await latestTimestamp();
          await setNextBlockTimestamp(latestBlockTimestamp + 1);
          await advanceBlock();
          const claimableAlice = await staking.claimable(alice.address);
          const claimableCarol = await staking.claimable(carol.address);
          expect(claimableAlice).to.be.equal(getBigNumber(250, 13));
          expect(claimableCarol).to.be.equal(getBigNumber(500, 13));
        });

        it("user can add new tokens to token stake and rewards will be updated", async () => {
          await advanceTimeAndBlock(9);
          await expect(staking.connect(alice).addStake(getBigNumber(100)))
            .to.emit(staking, "StakeAdded")
            .withArgs(alice.address, getBigNumber(100))
            .and.to.emit(token, "Transfer")
            .withArgs(alice.address, staking.address, getBigNumber(100));

          const aliceStake = await staking.tokenStake(alice.address);
          expect(aliceStake["tokens"]).to.be.equal(getBigNumber(200));
          expect(aliceStake["rewards"]).to.be.equal(getBigNumber(250, 14));
          expect(aliceStake["rewardPerTokenPaid"]).to.be.equal(getBigNumber(250, 12));

          expect(await staking.rewardRate()).to.be.equal(rewardRatePerToken);

          const claimableAlice = await staking.claimable(alice.address);
          const claimableBob = await staking.claimable(bob.address);
          expect(claimableAlice).to.be.equal(getBigNumber(250, 14));
          expect(claimableBob).to.be.equal(getBigNumber(250, 14));
        });

        it("user can claim tokens from token stake and rewards will be updated", async () => {
          await advanceTimeAndBlock(9);
          await expect(staking.connect(alice).claim()).to.emit(staking, "Claimed").withArgs(alice.address, getBigNumber(250, 14));

          const aliceStake = await staking.tokenStake(alice.address);
          expect(aliceStake["tokens"]).to.be.equal(getBigNumber(100));
          expect(aliceStake["rewards"]).to.be.equal(0);
          expect(aliceStake["rewardPerTokenPaid"]).to.be.equal(getBigNumber(250, 12));

          expect(await staking.rewardRate()).to.be.equal(rewardRatePerToken);

          const claimableAlice = await staking.claimable(alice.address);
          const claimableBob = await staking.claimable(bob.address);
          expect(claimableAlice).to.be.equal(0);
          expect(claimableBob).to.be.equal(getBigNumber(250, 14));
        });

        describe("while requesting unstake", () => {
          it("should correctly request unstake and rewards will be counted", async () => {
            await advanceTimeAndBlock(99);
            await expect(staking.connect(alice).requestUnstake()).to.emit(staking, "StakeRemoveRequested").withArgs(alice.address);

            const timestamp = await latest();
            const aliceStake = await staking.tokenStake(alice.address);
            expect(aliceStake["tokens"]).to.be.equal(getBigNumber(100));
            expect(aliceStake["rewards"]).to.be.equal(getBigNumber(250, 15));
            expect(aliceStake["isWithdrawing"]).to.be.equal(true);
            expect(aliceStake["withdrawalPossibleAt"]).to.be.equal(timestamp.add(seven_days));
          });

          describe("after request unstake and after 1000 sec", () => {
            beforeEach(async () => {
              const nextBlockTimestamp = (await latestTimestamp()) + 1000;
              await setNextBlockTimestamp(nextBlockTimestamp);
              await staking.connect(alice).requestUnstake();
            });

            it("claimable should return amount of collected rewards", async () => {
              const claimable = await staking.claimable(alice.address);
              expect(claimable).to.be.equal(getBigNumber(250, 16));
            });

            it("claimable should return 0 when rewards claimed after request unstake", async () => {
              await staking.connect(alice).claim();
              const claimable = await staking.claimable(alice.address);
              expect(claimable).to.be.equal(0);
            });

            it("user can claim collected rewards but new rewards will not be calculated for him", async () => {
              await advanceTimeAndBlock(999);
              await expect(staking.connect(alice).claim()).to.emit(staking, "Claimed").withArgs(alice.address, getBigNumber(250, 16));

              const aliceStake = await staking.tokenStake(alice.address);
              expect(aliceStake["tokens"]).to.be.equal(getBigNumber(100));
              expect(aliceStake["rewards"]).to.be.equal(0);
              expect(aliceStake["rewardPerTokenPaid"]).to.be.equal(getBigNumber(250, 14));

              expect(await staking.rewardRate()).to.be.equal(rewardRatePerToken);

              const claimableAlice = await staking.claimable(alice.address);
              const claimableBob = await staking.claimable(bob.address);
              expect(claimableAlice).to.be.equal(0);
              expect(claimableBob).to.be.equal(getBigNumber(500, 16));
            });

            describe("before 7 days of unstake period", () => {
              it("should revert when requesting unstake", async () => {
                await expect(staking.connect(alice).unstake()).to.be.revertedWith(ERR_UNSTAKE);
              });

              it("unstakeWithFee should correctly unstake tokens with 10% fee and transfer reward", async () => {
                await expect(staking.connect(alice).unstakeWithFee())
                  .to.emit(staking, "StakeRemoved")
                  .withArgs(alice.address, getBigNumber(100))
                  .and.to.emit(token, "Transfer")
                  .withArgs(staking.address, alice.address, getBigNumber(900, 17))
                  .and.to.emit(promo, "Transfer")
                  .withArgs(ZERO_ADDRESS, alice.address, getBigNumber(25, 17))
                  .and.to.emit(staking, "Claimed")
                  .withArgs(alice.address, getBigNumber(25, 17));

                const aliceStake = await staking.tokenStake(alice.address);
                expect(aliceStake["tokens"]).to.be.equal(0);
                expect(aliceStake["start"]).to.be.equal(0);
              });
            });

            describe("after 7 days of unstake period", () => {
              beforeEach(async () => {
                await advanceTimeAndBlock(seven_days);
              });

              it("unstake should correctly withdraw staked tokens and claim rewards", async () => {
                await expect(staking.connect(alice).unstake())
                  .to.emit(staking, "StakeRemoved")
                  .withArgs(alice.address, getBigNumber(100))
                  .and.to.emit(token, "Transfer")
                  .withArgs(staking.address, alice.address, getBigNumber(1000, 17))
                  .and.to.emit(promo, "Transfer")
                  .withArgs(ZERO_ADDRESS, alice.address, getBigNumber(25, 17))
                  .and.to.emit(staking, "Claimed")
                  .withArgs(alice.address, getBigNumber(25, 17));

                const aliceStake = await staking.tokenStake(alice.address);
                expect(aliceStake["tokens"]).to.be.equal(0);
                expect(aliceStake["start"]).to.be.equal(0);
              });

              it("unstakeWithFee should revert as there is an option to unstake without fee", async () => {
                await expect(staking.connect(alice).unstakeWithFee()).to.be.revertedWith(ERR_UNSTAKE_FIRST);
              });
            });
          });
        });
      });
    });
  });
});
