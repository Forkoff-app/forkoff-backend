import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

// Token pricing (Claude 3.5 Sonnet pricing as of 2024)
const INPUT_TOKEN_COST_PER_MILLION = 3.0; // $3 per 1M input tokens
const OUTPUT_TOKEN_COST_PER_MILLION = 15.0; // $15 per 1M output tokens

export interface RecordUsageDto {
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageStats {
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  totalTokens: bigint;
  totalSessionCount: number;
  estimatedCostUsd: number;
  period: string;
}

export interface DailyUsage {
  date: Date;
  inputTokens: bigint;
  outputTokens: bigint;
  sessionCount: number;
  estimatedCostUsd: number | null;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Calculate estimated cost in USD for token usage
   */
  calculateCost(inputTokens: number | bigint, outputTokens: number | bigint): number {
    const inputCost = (Number(inputTokens) / 1_000_000) * INPUT_TOKEN_COST_PER_MILLION;
    const outputCost = (Number(outputTokens) / 1_000_000) * OUTPUT_TOKEN_COST_PER_MILLION;
    return Math.round((inputCost + outputCost) * 10000) / 10000; // 4 decimal places
  }

  /**
   * Record token usage for a user (called when token_usage events come in)
   */
  async recordTokenUsage(userId: string, data: RecordUsageDto): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const estimatedCost = this.calculateCost(data.inputTokens, data.outputTokens);

    // Upsert daily usage record
    await this.prisma.tokenUsageDaily.upsert({
      where: {
        userId_date: {
          userId,
          date: today,
        },
      },
      update: {
        inputTokens: {
          increment: data.inputTokens,
        },
        outputTokens: {
          increment: data.outputTokens,
        },
        sessionCount: {
          increment: 1,
        },
        estimatedCostUsd: {
          increment: estimatedCost,
        },
      },
      create: {
        userId,
        date: today,
        inputTokens: BigInt(data.inputTokens),
        outputTokens: BigInt(data.outputTokens),
        sessionCount: 1,
        estimatedCostUsd: new Decimal(estimatedCost),
      },
    });

    this.logger.debug(
      `Recorded usage for user ${userId}: ${data.inputTokens} input, ${data.outputTokens} output`,
    );
  }

  /**
   * Get aggregated usage stats for a user
   */
  async getUserStats(
    userId: string,
    period: 'day' | 'week' | 'month' | 'all' = 'all',
  ): Promise<UsageStats> {
    const startDate = this.getStartDate(period);

    const result = await this.prisma.tokenUsageDaily.aggregate({
      where: {
        userId,
        ...(startDate && { date: { gte: startDate } }),
      },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        sessionCount: true,
        estimatedCostUsd: true,
      },
    });

    const totalInputTokens = result._sum.inputTokens ?? BigInt(0);
    const totalOutputTokens = result._sum.outputTokens ?? BigInt(0);

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalSessionCount: result._sum.sessionCount ?? 0,
      estimatedCostUsd: result._sum.estimatedCostUsd?.toNumber() ?? 0,
      period,
    };
  }

  /**
   * Get daily usage breakdown for a user
   */
  async getDailyUsage(
    userId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<DailyUsage[]> {
    const where: any = { userId };

    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = startDate;
      if (endDate) where.date.lte = endDate;
    }

    const records = await this.prisma.tokenUsageDaily.findMany({
      where,
      orderBy: { date: 'asc' },
    });

    return records.map((record) => ({
      date: record.date,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      sessionCount: record.sessionCount,
      estimatedCostUsd: record.estimatedCostUsd?.toNumber() ?? null,
    }));
  }

  /**
   * Get total lifetime tokens for a user (used for achievement checking)
   */
  async getTotalTokens(userId: string): Promise<bigint> {
    const result = await this.prisma.tokenUsageDaily.aggregate({
      where: { userId },
      _sum: {
        inputTokens: true,
        outputTokens: true,
      },
    });

    const inputTokens = result._sum.inputTokens ?? BigInt(0);
    const outputTokens = result._sum.outputTokens ?? BigInt(0);

    return inputTokens + outputTokens;
  }

  /**
   * Get total session count for a user
   */
  async getTotalSessionCount(userId: string): Promise<number> {
    const result = await this.prisma.tokenUsageDaily.aggregate({
      where: { userId },
      _sum: {
        sessionCount: true,
      },
    });

    return result._sum.sessionCount ?? 0;
  }

  /**
   * Get number of active days for a user
   */
  async getActiveDaysCount(userId: string): Promise<number> {
    const result = await this.prisma.tokenUsageDaily.count({
      where: {
        userId,
        sessionCount: { gt: 0 },
      },
    });

    return result;
  }

  /**
   * Get current streak (consecutive days with activity)
   */
  async getCurrentStreak(userId: string): Promise<number> {
    const records = await this.prisma.tokenUsageDaily.findMany({
      where: {
        userId,
        sessionCount: { gt: 0 },
      },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

    if (records.length === 0) return 0;

    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < records.length; i++) {
      const recordDate = new Date(records[i].date);
      recordDate.setHours(0, 0, 0, 0);

      const expectedDate = new Date(today);
      expectedDate.setDate(today.getDate() - i);

      if (recordDate.getTime() === expectedDate.getTime()) {
        streak++;
      } else if (i === 0 && recordDate.getTime() === expectedDate.getTime() - 86400000) {
        // Allow for checking yesterday if today has no activity
        const yesterdayExpected = new Date(today);
        yesterdayExpected.setDate(today.getDate() - 1);
        if (recordDate.getTime() === yesterdayExpected.getTime()) {
          streak++;
        }
      } else {
        break;
      }
    }

    return streak;
  }

  /**
   * Helper: Get start date for period
   */
  private getStartDate(period: 'day' | 'week' | 'month' | 'all'): Date | null {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    switch (period) {
      case 'day':
        return now;
      case 'week':
        now.setDate(now.getDate() - 7);
        return now;
      case 'month':
        now.setDate(now.getDate() - 30);
        return now;
      case 'all':
      default:
        return null;
    }
  }
}
