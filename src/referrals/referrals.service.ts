import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  ReferralCodeResponseDto,
  ReferralStatsDto,
  ReferralDto,
  ClaimRewardResponseDto,
  ApplyReferralResponseDto,
} from './dto';

// Referral reward constants
const CONVERSIONS_PER_REWARD = 3;
const REWARD_MONTHS = 1;

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);
  private readonly appUrl: string;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.appUrl =
      this.configService.get<string>('APP_URL') || 'https://forkoff.app';
  }

  /**
   * Get or create user's referral code
   */
  async getOrCreateReferralCode(userId: string): Promise<ReferralCodeResponseDto> {
    let profile = await this.prisma.referralProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      profile = await this.prisma.referralProfile.create({
        data: {
          userId,
          referralCode: this.generateReferralCode(),
        },
      });
      this.logger.log(`Created referral profile for user ${userId}`);
    }

    const stats = this.calculateStats(profile);

    return {
      referralCode: profile.referralCode,
      shareUrl: `${this.appUrl}/r/${profile.referralCode}`,
      stats,
    };
  }

  /**
   * Get referral statistics
   */
  async getStats(userId: string): Promise<ReferralCodeResponseDto> {
    return this.getOrCreateReferralCode(userId);
  }

  /**
   * Get list of referrals for a user
   */
  async getReferrals(userId: string): Promise<ReferralDto[]> {
    const profile = await this.prisma.referralProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      return [];
    }

    const referrals = await this.prisma.referral.findMany({
      where: { referrerProfileId: profile.id },
      include: {
        referredUser: {
          select: { email: true },
        },
      },
      orderBy: { signedUpAt: 'desc' },
    });

    return referrals.map((r) => ({
      id: r.id,
      referredUserEmail: this.maskEmail(r.referredUser.email),
      signedUpAt: r.signedUpAt.toISOString(),
      isConverted: r.isConverted,
      convertedAt: r.convertedAt?.toISOString(),
    }));
  }

  /**
   * Apply a referral code to a user (during signup)
   */
  async applyReferralCode(
    userId: string,
    code: string,
  ): Promise<ApplyReferralResponseDto> {
    const normalizedCode = code.trim().toUpperCase();

    // Find the referrer's profile
    const referrerProfile = await this.prisma.referralProfile.findUnique({
      where: { referralCode: normalizedCode },
    });

    if (!referrerProfile) {
      return {
        success: false,
        message: 'Invalid referral code',
      };
    }

    // Prevent self-referral
    if (referrerProfile.userId === userId) {
      return {
        success: false,
        message: 'You cannot use your own referral code',
      };
    }

    // Check if user already has a referral
    const existingReferral = await this.prisma.referral.findUnique({
      where: { referredUserId: userId },
    });

    if (existingReferral) {
      return {
        success: false,
        message: 'You have already been referred',
      };
    }

    // Create referral record and increment total referrals
    await this.prisma.$transaction(async (tx) => {
      await tx.referral.create({
        data: {
          referrerProfileId: referrerProfile.id,
          referredUserId: userId,
        },
      });

      await tx.referralProfile.update({
        where: { id: referrerProfile.id },
        data: {
          totalReferrals: { increment: 1 },
        },
      });
    });

    this.logger.log(
      `User ${userId} applied referral code ${normalizedCode} from user ${referrerProfile.userId}`,
    );

    return {
      success: true,
      message: 'Referral code applied successfully',
    };
  }

  /**
   * Mark a referred user as converted (called when they subscribe to PRO)
   */
  async markConversion(userId: string): Promise<void> {
    const referral = await this.prisma.referral.findUnique({
      where: { referredUserId: userId },
      include: { referrerProfile: true },
    });

    if (!referral || referral.isConverted) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // Mark referral as converted
      await tx.referral.update({
        where: { id: referral.id },
        data: {
          isConverted: true,
          convertedAt: new Date(),
        },
      });

      // Increment successful referrals
      const updatedProfile = await tx.referralProfile.update({
        where: { id: referral.referrerProfileId },
        data: {
          successfulReferrals: { increment: 1 },
        },
      });

      // Check if we should grant a reward (every 3 conversions)
      if (updatedProfile.successfulReferrals % CONVERSIONS_PER_REWARD === 0) {
        await tx.referralProfile.update({
          where: { id: referral.referrerProfileId },
          data: {
            rewardMonthsEarned: { increment: REWARD_MONTHS },
          },
        });

        await tx.referral.update({
          where: { id: referral.id },
          data: { rewardGranted: true },
        });

        this.logger.log(
          `User ${referral.referrerProfile.userId} earned ${REWARD_MONTHS} reward month(s) from referrals`,
        );
      }
    });

    this.logger.log(
      `Referral converted: user ${userId} referred by ${referral.referrerProfile.userId}`,
    );
  }

  /**
   * Claim earned reward months
   */
  async claimReward(userId: string): Promise<ClaimRewardResponseDto> {
    const profile = await this.prisma.referralProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      return {
        success: false,
        message: 'No referral profile found',
      };
    }

    const availableMonths =
      profile.rewardMonthsEarned - profile.rewardMonthsClaimed;

    if (availableMonths <= 0) {
      return {
        success: false,
        message: 'No reward months available to claim',
      };
    }

    // Get current user to calculate new expiry
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { proExpiresAt: true, isLifetimePro: true },
    });

    if (user?.isLifetimePro) {
      return {
        success: false,
        message: 'You already have lifetime PRO access',
      };
    }

    // Calculate new expiry date
    const startDate =
      user?.proExpiresAt && user.proExpiresAt > new Date()
        ? user.proExpiresAt
        : new Date();

    const newExpiresAt = new Date(startDate);
    newExpiresAt.setMonth(newExpiresAt.getMonth() + availableMonths);

    // Update user and mark rewards as claimed
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          proExpiresAt: newExpiresAt,
          subscription: 'pro',
        },
      });

      await tx.referralProfile.update({
        where: { userId },
        data: {
          rewardMonthsClaimed: profile.rewardMonthsEarned,
        },
      });
    });

    this.logger.log(
      `User ${userId} claimed ${availableMonths} referral reward month(s)`,
    );

    return {
      success: true,
      message: `You claimed ${availableMonths} month${availableMonths > 1 ? 's' : ''} of PRO access!`,
      monthsClaimed: availableMonths,
      newExpiresAt: newExpiresAt.toISOString(),
    };
  }

  /**
   * Generate a unique referral code
   */
  private generateReferralCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * Mask email for privacy
   */
  private maskEmail(email: string): string {
    const [localPart, domain] = email.split('@');
    if (localPart.length <= 2) {
      return `${localPart[0]}***@${domain}`;
    }
    return `${localPart[0]}${localPart[1]}***@${domain}`;
  }

  /**
   * Calculate referral statistics from profile
   */
  private calculateStats(profile: {
    totalReferrals: number;
    successfulReferrals: number;
    rewardMonthsEarned: number;
    rewardMonthsClaimed: number;
  }): ReferralStatsDto {
    return {
      totalReferrals: profile.totalReferrals,
      successfulConversions: profile.successfulReferrals,
      rewardMonthsAvailable:
        profile.rewardMonthsEarned - profile.rewardMonthsClaimed,
      nextRewardProgress: profile.successfulReferrals % CONVERSIONS_PER_REWARD,
    };
  }
}
