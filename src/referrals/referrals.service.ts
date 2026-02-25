import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { truncateId, maskCode } from '../logging/sanitize';
import {
  ReferralCodeResponseDto,
  ReferralStatsDto,
  ReferralDto,
  ClaimRewardResponseDto,
  ApplyReferralResponseDto,
} from './dto';

// Referral reward constants
const BASE_CONVERSIONS = 3; // First tier requires 3 conversions
const REWARD_MONTHS = 1;

/**
 * Calculate total conversions needed for N reward months (gamified tiers)
 * Tier 1: 3, Tier 2: 6 more (9 total), Tier 3: 9 more (18 total), etc.
 * Formula: 3 * n * (n + 1) / 2
 */
function getConversionsNeededForMonths(months: number): number {
  return (BASE_CONVERSIONS * months * (months + 1)) / 2;
}

/**
 * Calculate how many reward months earned from total conversions
 * Inverse of the above formula
 */
function getMonthsEarnedFromConversions(conversions: number): number {
  if (conversions < BASE_CONVERSIONS) return 0;
  // Solve: 3 * n * (n + 1) / 2 <= conversions
  // n = floor((-1 + sqrt(1 + 8 * conversions / 3)) / 2)
  const n = Math.floor((-1 + Math.sqrt(1 + (8 * conversions) / BASE_CONVERSIONS)) / 2);
  return n;
}

/**
 * Get conversions needed for the next tier
 */
function getConversionsForNextTier(currentMonths: number): number {
  return BASE_CONVERSIONS * (currentMonths + 1);
}

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
      this.logger.log(`Created referral profile for user ${truncateId(userId)}`);
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
      `User ${truncateId(userId)} applied referral code ${maskCode(normalizedCode)} from user ${truncateId(referrerProfile.userId)}`,
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

      // Calculate rewards using gamified tier system
      // Tier 1: 3 conversions, Tier 2: 9 total, Tier 3: 18 total, etc.
      const previousMonthsEarned = getMonthsEarnedFromConversions(
        updatedProfile.successfulReferrals - 1,
      );
      const newMonthsEarned = getMonthsEarnedFromConversions(
        updatedProfile.successfulReferrals,
      );

      // Check if this conversion unlocked a new reward tier
      if (newMonthsEarned > previousMonthsEarned) {
        await tx.referralProfile.update({
          where: { id: referral.referrerProfileId },
          data: {
            rewardMonthsEarned: newMonthsEarned,
          },
        });

        await tx.referral.update({
          where: { id: referral.id },
          data: { rewardGranted: true },
        });

        this.logger.log(
          `User ${truncateId(referral.referrerProfile.userId)} earned reward month #${newMonthsEarned} from referrals (${updatedProfile.successfulReferrals} total conversions)`,
        );
      }
    });

    this.logger.log(
      `Referral converted: user ${truncateId(userId)} referred by ${truncateId(referral.referrerProfile.userId)}`,
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
      `User ${truncateId(userId)} claimed ${availableMonths} referral reward month(s)`,
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
    const currentMonthsEarned = getMonthsEarnedFromConversions(
      profile.successfulReferrals,
    );
    const conversionsForCurrentTier = getConversionsNeededForMonths(currentMonthsEarned);
    const conversionsForNextTier = getConversionsNeededForMonths(currentMonthsEarned + 1);
    const conversionsNeededForNext = conversionsForNextTier - conversionsForCurrentTier;
    const progressInCurrentTier = profile.successfulReferrals - conversionsForCurrentTier;

    return {
      totalReferrals: profile.totalReferrals,
      successfulConversions: profile.successfulReferrals,
      rewardMonthsAvailable:
        profile.rewardMonthsEarned - profile.rewardMonthsClaimed,
      nextRewardProgress: progressInCurrentTier,
      nextRewardTarget: conversionsNeededForNext,
    };
  }
}
