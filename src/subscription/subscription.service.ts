import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  LimitType,
  SubscriptionLimits,
  SubscriptionTier,
  getLimitsForTier,
} from './constants';
import { LimitCheckResponseDto } from './dto';
import {
  AppConfigService,
  TierLimits,
} from '../app-config/app-config.service';
import { truncateId } from '../logging/sanitize';

/**
 * Map a TierLimits object from the DB (where -1 means unlimited)
 * to a SubscriptionLimits object (where Infinity means unlimited).
 */
function mapTierLimits(tier: TierLimits): SubscriptionLimits {
  const map = (v: number) => (v === -1 ? Infinity : v);
  return {
    messagesPerDay: map(tier.messagesPerDay),
    sessionsPerMonth: map(tier.sessionsPerMonth),
    maxProjects: map(tier.maxProjects),
    maxDevices: map(tier.maxDevices),
    repairsPerMonth: map(tier.repairsPerMonth),
    historyRetentionDays: map(tier.historyRetentionDays),
    maxPhoneSessions: tier.maxPhoneSessions != null ? map(tier.maxPhoneSessions) : undefined,
  };
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private appConfigService: AppConfigService,
  ) {}

  /**
   * Get or create usage record for a user
   */
  async getOrCreateUsage(userId: string) {
    let usage = await this.prisma.subscriptionUsage.findUnique({
      where: { userId },
    });

    if (!usage) {
      usage = await this.prisma.subscriptionUsage.create({
        data: {
          userId,
          messageLimitResetAt: this.getNextMidnightUTC(),
          monthlyLimitResetAt: this.getNextMonthStart(),
        },
      });
    }

    // Check if daily reset is needed
    if (new Date(usage.messageLimitResetAt) <= new Date()) {
      usage = await this.prisma.subscriptionUsage.update({
        where: { userId },
        data: {
          messagesUsedToday: 0,
          messageLimitResetAt: this.getNextMidnightUTC(),
        },
      });
    }

    // Check if monthly reset is needed
    if (new Date(usage.monthlyLimitResetAt) <= new Date()) {
      usage = await this.prisma.subscriptionUsage.update({
        where: { userId },
        data: {
          sessionsUsedThisMonth: 0,
          repairsUsedThisMonth: 0,
          monthlyLimitResetAt: this.getNextMonthStart(),
        },
      });
    }

    return usage;
  }

  /**
   * Get limits based on user's subscription tier.
   * Reads from AppConfig DB first, falls back to hardcoded constants.
   */
  async getLimitsForUser(userId: string): Promise<SubscriptionLimits> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { subscription: true, isLifetimePro: true, proExpiresAt: true },
    });

    // Check if user has active PRO status (from vouchers/referrals)
    const hasActivePro = await this.checkProStatus(userId);
    const tier: SubscriptionTier =
      hasActivePro && user?.subscription === 'free'
        ? 'pro'
        : ((user?.subscription || 'free') as SubscriptionTier);

    return this.getLimitsForTier(tier);
  }

  /**
   * Get limits for a specific tier from AppConfig (DB) with hardcoded fallback.
   */
  async getLimitsForTier(tier: SubscriptionTier): Promise<SubscriptionLimits> {
    try {
      const config = await this.appConfigService.getSubscriptionLimits();
      const tierConfig = config[tier] || config.free;
      return mapTierLimits(tierConfig);
    } catch (error) {
      this.logger.warn(
        `Failed to read subscription limits from DB, using hardcoded fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return getLimitsForTier(tier);
    }
  }

  /**
   * Check if user has active PRO status (from subscription, voucher, or referral)
   * Returns true if user should be treated as PRO
   */
  async checkProStatus(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscription: true,
        isLifetimePro: true,
        proExpiresAt: true,
      },
    });

    if (!user) {
      return false;
    }

    // Check if user has lifetime PRO
    if (user.isLifetimePro) {
      return true;
    }

    // Check if user has active PRO subscription
    if (user.subscription === 'pro') {
      return true;
    }

    // Check if user has unexpired PRO from voucher/referral
    if (user.proExpiresAt && user.proExpiresAt > new Date()) {
      return true;
    }

    return false;
  }

  /**
   * Auto-downgrade expired PRO users (call from cron or when checking status)
   */
  async autoDowngradeExpiredPro(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscription: true,
        isLifetimePro: true,
        proExpiresAt: true,
        stripeSubscriptionId: true,
      },
    });

    if (!user) {
      return;
    }

    // Don't downgrade lifetime PRO users
    if (user.isLifetimePro) {
      return;
    }

    // Don't downgrade users with active Stripe subscriptions
    if (user.stripeSubscriptionId) {
      return;
    }

    // Check if PRO has expired
    if (
      user.subscription === 'pro' &&
      user.proExpiresAt &&
      user.proExpiresAt <= new Date()
    ) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          subscription: 'free',
        },
      });
      this.logger.log(`User ${truncateId(userId)} auto-downgraded from PRO (expired)`);
    }
  }

  /**
   * Check if a specific action is allowed
   */
  async checkLimit(
    userId: string,
    limitType: LimitType,
  ): Promise<LimitCheckResponseDto> {
    const usage = await this.getOrCreateUsage(userId);
    const limits = await this.getLimitsForUser(userId);

    switch (limitType) {
      case 'messages_daily':
        return {
          allowed: usage.messagesUsedToday < limits.messagesPerDay,
          limitType,
          currentUsage: usage.messagesUsedToday,
          limit: limits.messagesPerDay,
          resetAt: usage.messageLimitResetAt.toISOString(),
        };

      case 'sessions_monthly':
        return {
          allowed: usage.sessionsUsedThisMonth < limits.sessionsPerMonth,
          limitType,
          currentUsage: usage.sessionsUsedThisMonth,
          limit: limits.sessionsPerMonth,
          resetAt: usage.monthlyLimitResetAt.toISOString(),
        };

      case 'repairs_monthly':
        return {
          allowed: usage.repairsUsedThisMonth < limits.repairsPerMonth,
          limitType,
          currentUsage: usage.repairsUsedThisMonth,
          limit: limits.repairsPerMonth,
          resetAt: usage.monthlyLimitResetAt.toISOString(),
        };

      case 'projects_max': {
        const projectCount = await this.prisma.project.count({
          where: { userId },
        });
        return {
          allowed: projectCount < limits.maxProjects,
          limitType,
          currentUsage: projectCount,
          limit: limits.maxProjects,
        };
      }

      case 'devices_max': {
        const deviceCount = await this.prisma.device.count({
          where: { userId },
        });
        return {
          allowed: deviceCount < limits.maxDevices,
          limitType,
          currentUsage: deviceCount,
          limit: limits.maxDevices,
        };
      }

      case 'phone_session': {
        // Pro feature - always allowed for Pro, never for free
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { subscription: true },
        });
        const isPro =
          user?.subscription === 'pro';
        return {
          allowed: isPro,
          limitType,
          limit: isPro ? 1 : 0,
        };
      }

      default:
        return { allowed: true };
    }
  }

  /**
   * Record a message sent and check limit
   */
  async recordMessageSent(
    userId: string,
  ): Promise<LimitCheckResponseDto & { currentUsage: number }> {
    const usage = await this.getOrCreateUsage(userId);
    const limits = await this.getLimitsForUser(userId);

    // Check limit first
    if (usage.messagesUsedToday >= limits.messagesPerDay) {
      return {
        allowed: false,
        limitType: 'messages_daily',
        currentUsage: usage.messagesUsedToday,
        limit: limits.messagesPerDay,
        resetAt: usage.messageLimitResetAt.toISOString(),
      };
    }

    // Increment counter
    const updated = await this.prisma.subscriptionUsage.update({
      where: { userId },
      data: { messagesUsedToday: { increment: 1 } },
    });

    return {
      allowed: true,
      limitType: 'messages_daily',
      currentUsage: updated.messagesUsedToday,
      limit: limits.messagesPerDay,
      resetAt: updated.messageLimitResetAt.toISOString(),
    };
  }

  /**
   * Record a session started and check limit
   */
  async recordSessionStarted(
    userId: string,
  ): Promise<LimitCheckResponseDto & { currentUsage: number }> {
    const usage = await this.getOrCreateUsage(userId);
    const limits = await this.getLimitsForUser(userId);

    // Check limit first
    if (usage.sessionsUsedThisMonth >= limits.sessionsPerMonth) {
      return {
        allowed: false,
        limitType: 'sessions_monthly',
        currentUsage: usage.sessionsUsedThisMonth,
        limit: limits.sessionsPerMonth,
        resetAt: usage.monthlyLimitResetAt.toISOString(),
      };
    }

    // Increment counter
    const updated = await this.prisma.subscriptionUsage.update({
      where: { userId },
      data: { sessionsUsedThisMonth: { increment: 1 } },
    });

    return {
      allowed: true,
      limitType: 'sessions_monthly',
      currentUsage: updated.sessionsUsedThisMonth,
      limit: limits.sessionsPerMonth,
      resetAt: updated.monthlyLimitResetAt.toISOString(),
    };
  }

  /**
   * Record a device re-pair and check limit
   */
  async recordDeviceRepair(
    userId: string,
  ): Promise<LimitCheckResponseDto & { currentUsage: number }> {
    const usage = await this.getOrCreateUsage(userId);
    const limits = await this.getLimitsForUser(userId);

    // Check limit first
    if (usage.repairsUsedThisMonth >= limits.repairsPerMonth) {
      return {
        allowed: false,
        limitType: 'repairs_monthly',
        currentUsage: usage.repairsUsedThisMonth,
        limit: limits.repairsPerMonth,
        resetAt: usage.monthlyLimitResetAt.toISOString(),
      };
    }

    // Increment counter
    const updated = await this.prisma.subscriptionUsage.update({
      where: { userId },
      data: { repairsUsedThisMonth: { increment: 1 } },
    });

    return {
      allowed: true,
      limitType: 'repairs_monthly',
      currentUsage: updated.repairsUsedThisMonth,
      limit: limits.repairsPerMonth,
      resetAt: updated.monthlyLimitResetAt.toISOString(),
    };
  }

  /**
   * Get current usage stats for a user
   */
  async getUsageStats(userId: string) {
    const usage = await this.getOrCreateUsage(userId);

    // Get project and device counts
    const [activeProjectCount, pairedDeviceCount] = await Promise.all([
      this.prisma.project.count({ where: { userId } }),
      this.prisma.device.count({ where: { userId } }),
    ]);

    return {
      messagesUsedToday: usage.messagesUsedToday,
      messageLimitResetAt: usage.messageLimitResetAt.toISOString(),
      sessionsUsedThisMonth: usage.sessionsUsedThisMonth,
      repairsUsedThisMonth: usage.repairsUsedThisMonth,
      monthlyLimitResetAt: usage.monthlyLimitResetAt.toISOString(),
      activeProjectCount,
      pairedDeviceCount,
    };
  }

  /**
   * Cron job: Reset daily counters at midnight UTC
   */
  @Cron('0 0 * * *') // Every day at midnight UTC
  async resetDailyCounters() {
    const result = await this.prisma.subscriptionUsage.updateMany({
      data: {
        messagesUsedToday: 0,
        messageLimitResetAt: this.getNextMidnightUTC(),
      },
    });
    this.logger.log(`Daily message counters reset for ${result.count} users`);
  }

  /**
   * Cron job: Reset monthly counters on 1st of each month
   */
  @Cron('0 0 1 * *') // 1st of each month at midnight UTC
  async resetMonthlyCounters() {
    const result = await this.prisma.subscriptionUsage.updateMany({
      data: {
        sessionsUsedThisMonth: 0,
        repairsUsedThisMonth: 0,
        monthlyLimitResetAt: this.getNextMonthStart(),
      },
    });
    this.logger.log(`Monthly counters reset for ${result.count} users`);
  }

  /**
   * Verify an Apple App Store receipt and activate subscription.
   * Uses Apple's verifyReceipt endpoint to validate the purchase.
   */
  async verifyAppleReceipt(
    userId: string,
    receipt: string,
    productId: string,
  ): Promise<{ success: boolean; subscription?: string; error?: string }> {
    const sharedSecret = this.configService.get<string>(
      'APPLE_SHARED_SECRET',
    );

    if (!sharedSecret) {
      this.logger.error('APPLE_SHARED_SECRET not configured');
      return { success: false, error: 'Apple IAP not configured on server' };
    }

    // Map product ID to subscription tier
    const validProducts = [
      'com.forkoff.pro.monthly',
      'com.forkoff.pro.yearly',
    ];
    if (!validProducts.includes(productId)) {
      return { success: false, error: 'Invalid product ID' };
    }

    try {
      // Try production first, fall back to sandbox
      let verifyResult = await this.callAppleVerifyReceipt(
        receipt,
        sharedSecret,
        false,
      );

      // Status 21007 = sandbox receipt sent to production, retry with sandbox
      if (verifyResult.status === 21007) {
        verifyResult = await this.callAppleVerifyReceipt(
          receipt,
          sharedSecret,
          true,
        );
      }

      if (verifyResult.status !== 0) {
        this.logger.warn(
          `Apple receipt verification failed with status ${verifyResult.status} for user ${truncateId(userId)}`,
        );
        return {
          success: false,
          error: `Receipt verification failed (status ${verifyResult.status})`,
        };
      }

      // Find the matching subscription in the receipt
      const latestReceiptInfo =
        verifyResult.latest_receipt_info || [];
      const matchingPurchase = latestReceiptInfo
        .filter(
          (item: any) =>
            item.product_id === productId ||
            validProducts.includes(item.product_id),
        )
        .sort(
          (a: any, b: any) =>
            parseInt(b.expires_date_ms || '0') -
            parseInt(a.expires_date_ms || '0'),
        )[0];

      if (!matchingPurchase) {
        return { success: false, error: 'No matching subscription found in receipt' };
      }

      // Check if subscription is active
      const expiresDateMs = parseInt(
        matchingPurchase.expires_date_ms || '0',
      );
      const isActive = expiresDateMs > Date.now();

      if (!isActive) {
        return { success: false, error: 'Subscription has expired' };
      }

      const originalTransactionId =
        matchingPurchase.original_transaction_id;
      const expiresAt = new Date(expiresDateMs);

      // Check if this transaction is already linked to another user
      if (originalTransactionId) {
        const existingUser = await this.prisma.user.findUnique({
          where: { appleOriginalTransactionId: originalTransactionId },
          select: { id: true },
        });

        if (existingUser && existingUser.id !== userId) {
          return {
            success: false,
            error: 'This subscription is already linked to another account',
          };
        }
      }

      // Activate the subscription
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          subscription: 'pro',
          appleOriginalTransactionId: originalTransactionId || undefined,
          stripeCurrentPeriodEnd: expiresAt,
          stripePriceId: matchingPurchase.product_id,
        },
      });

      this.logger.log(
        `User ${truncateId(userId)} activated Apple IAP subscription (product: ${matchingPurchase.product_id}, expires: ${expiresAt.toISOString()})`,
      );

      return { success: true, subscription: 'pro' };
    } catch (error) {
      this.logger.error(
        `Apple receipt verification error for user ${truncateId(userId)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false, error: 'Receipt verification failed' };
    }
  }

  /**
   * Call Apple's verifyReceipt endpoint
   */
  private async callAppleVerifyReceipt(
    receipt: string,
    sharedSecret: string,
    useSandbox: boolean,
  ): Promise<any> {
    const url = useSandbox
      ? 'https://sandbox.itunes.apple.com/verifyReceipt'
      : 'https://buy.itunes.apple.com/verifyReceipt';

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        'receipt-data': receipt,
        password: sharedSecret,
        'exclude-old-transactions': true,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Apple API returned ${response.status}: ${response.statusText}`,
      );
    }

    return response.json();
  }

  // Helper: Get next midnight UTC
  private getNextMidnightUTC(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );
  }

  // Helper: Get start of next month UTC
  private getNextMonthStart(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    );
  }
}
