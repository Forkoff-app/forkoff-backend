import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Achievement, UserAchievement } from '@prisma/client';

export interface AchievementWithProgress extends Achievement {
  userProgress?: {
    unlockedAt: Date | null;
    progress: bigint;
    showcased: boolean;
  };
}

export interface UnlockedAchievement {
  achievement: Achievement;
  userAchievement: UserAchievement;
}

// Achievement definitions for seeding
export const ACHIEVEMENT_DEFINITIONS = [
  // Token Milestones
  {
    key: 'tokens_100k',
    name: 'Token Novice',
    description: 'Used 100,000 tokens total',
    category: 'TOKENS',
    iconName: 'Coins',
    tier: 'BRONZE',
    threshold: BigInt(100_000),
  },
  {
    key: 'tokens_1m',
    name: 'Token Apprentice',
    description: 'Used 1,000,000 tokens total',
    category: 'TOKENS',
    iconName: 'Coins',
    tier: 'SILVER',
    threshold: BigInt(1_000_000),
  },
  {
    key: 'tokens_10m',
    name: 'Token Master',
    description: 'Used 10,000,000 tokens total',
    category: 'TOKENS',
    iconName: 'Coins',
    tier: 'GOLD',
    threshold: BigInt(10_000_000),
  },
  {
    key: 'tokens_100m',
    name: 'Token Legend',
    description: 'Used 100,000,000 tokens total',
    category: 'TOKENS',
    iconName: 'Crown',
    tier: 'PLATINUM',
    threshold: BigInt(100_000_000),
  },
  // Session Milestones
  {
    key: 'sessions_10',
    name: 'Getting Started',
    description: 'Completed 10 sessions',
    category: 'SESSIONS',
    iconName: 'MessageSquare',
    tier: 'BRONZE',
    threshold: BigInt(10),
  },
  {
    key: 'sessions_100',
    name: 'Power User',
    description: 'Completed 100 sessions',
    category: 'SESSIONS',
    iconName: 'MessageSquare',
    tier: 'SILVER',
    threshold: BigInt(100),
  },
  {
    key: 'sessions_500',
    name: 'Session Master',
    description: 'Completed 500 sessions',
    category: 'SESSIONS',
    iconName: 'MessageSquare',
    tier: 'GOLD',
    threshold: BigInt(500),
  },
  // Engagement Milestones
  {
    key: 'days_active_7',
    name: 'Week Warrior',
    description: 'Active for 7 days',
    category: 'ENGAGEMENT',
    iconName: 'Calendar',
    tier: 'BRONZE',
    threshold: BigInt(7),
  },
  {
    key: 'days_active_30',
    name: 'Monthly Maven',
    description: 'Active for 30 days',
    category: 'ENGAGEMENT',
    iconName: 'Calendar',
    tier: 'SILVER',
    threshold: BigInt(30),
  },
  {
    key: 'streak_7',
    name: 'Hot Streak',
    description: '7-day activity streak',
    category: 'ENGAGEMENT',
    iconName: 'Flame',
    tier: 'SILVER',
    threshold: BigInt(7),
  },
];

@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Get all achievement definitions
   */
  async getAllAchievements(): Promise<Achievement[]> {
    return this.prisma.achievement.findMany({
      orderBy: [{ category: 'asc' }, { threshold: 'asc' }],
    });
  }

  /**
   * Get all achievements with user progress (including progress towards locked achievements)
   */
  async getAchievementsWithProgress(
    userId: string,
    currentStats?: {
      totalTokens: bigint;
      totalSessions: number;
      activeDays: number;
      currentStreak: number;
    },
  ): Promise<AchievementWithProgress[]> {
    const [achievements, userAchievements] = await Promise.all([
      this.prisma.achievement.findMany({
        orderBy: [{ category: 'asc' }, { threshold: 'asc' }],
      }),
      this.prisma.userAchievement.findMany({
        where: { userId },
      }),
    ]);

    const userAchievementMap = new Map(
      userAchievements.map((ua) => [ua.achievementId, ua]),
    );

    return achievements.map((achievement) => {
      const userAchievement = userAchievementMap.get(achievement.id);

      // Calculate current progress for this achievement based on its category
      let currentProgress = BigInt(0);
      if (currentStats) {
        if (achievement.category === 'TOKENS') {
          currentProgress = currentStats.totalTokens;
        } else if (achievement.category === 'SESSIONS') {
          currentProgress = BigInt(currentStats.totalSessions);
        } else if (achievement.category === 'ENGAGEMENT') {
          if (achievement.key.startsWith('days_active_')) {
            currentProgress = BigInt(currentStats.activeDays);
          } else if (achievement.key.startsWith('streak_')) {
            currentProgress = BigInt(currentStats.currentStreak);
          }
        }
      }

      return {
        ...achievement,
        userProgress: userAchievement
          ? {
              unlockedAt: userAchievement.unlockedAt,
              progress: userAchievement.progress,
              showcased: userAchievement.showcased,
            }
          : currentStats
            ? {
                unlockedAt: null,
                progress: currentProgress,
                showcased: false,
              }
            : undefined,
      };
    });
  }

  /**
   * Get user's unlocked achievements
   */
  async getUserAchievements(userId: string): Promise<UnlockedAchievement[]> {
    const userAchievements = await this.prisma.userAchievement.findMany({
      where: { userId },
      include: { achievement: true },
      orderBy: { unlockedAt: 'desc' },
    });

    return userAchievements.map((ua) => ({
      achievement: ua.achievement,
      userAchievement: ua,
    }));
  }

  /**
   * Check and unlock token-based achievements
   * Returns newly unlocked achievements
   */
  async checkTokenMilestones(
    userId: string,
    totalTokens: bigint,
  ): Promise<UnlockedAchievement[]> {
    const tokenAchievements = await this.prisma.achievement.findMany({
      where: { category: 'TOKENS' },
      orderBy: { threshold: 'asc' },
    });

    const unlockedAchievements: UnlockedAchievement[] = [];

    for (const achievement of tokenAchievements) {
      if (totalTokens >= achievement.threshold) {
        const unlocked = await this.unlockAchievement(
          userId,
          achievement.id,
          totalTokens,
        );
        if (unlocked) {
          unlockedAchievements.push({
            achievement,
            userAchievement: unlocked,
          });
        }
      }
    }

    return unlockedAchievements;
  }

  /**
   * Check and unlock session-based achievements
   */
  async checkSessionMilestones(
    userId: string,
    totalSessions: number,
  ): Promise<UnlockedAchievement[]> {
    const sessionAchievements = await this.prisma.achievement.findMany({
      where: { category: 'SESSIONS' },
      orderBy: { threshold: 'asc' },
    });

    const unlockedAchievements: UnlockedAchievement[] = [];

    for (const achievement of sessionAchievements) {
      if (BigInt(totalSessions) >= achievement.threshold) {
        const unlocked = await this.unlockAchievement(
          userId,
          achievement.id,
          BigInt(totalSessions),
        );
        if (unlocked) {
          unlockedAchievements.push({
            achievement,
            userAchievement: unlocked,
          });
        }
      }
    }

    return unlockedAchievements;
  }

  /**
   * Check and unlock engagement-based achievements (active days, streaks)
   */
  async checkEngagementMilestones(
    userId: string,
    activeDays: number,
    currentStreak: number,
  ): Promise<UnlockedAchievement[]> {
    const engagementAchievements = await this.prisma.achievement.findMany({
      where: { category: 'ENGAGEMENT' },
    });

    const unlockedAchievements: UnlockedAchievement[] = [];

    for (const achievement of engagementAchievements) {
      let currentValue = 0;

      if (achievement.key.startsWith('days_active_')) {
        currentValue = activeDays;
      } else if (achievement.key.startsWith('streak_')) {
        currentValue = currentStreak;
      }

      if (BigInt(currentValue) >= achievement.threshold) {
        const unlocked = await this.unlockAchievement(
          userId,
          achievement.id,
          BigInt(currentValue),
        );
        if (unlocked) {
          unlockedAchievements.push({
            achievement,
            userAchievement: unlocked,
          });
        }
      }
    }

    return unlockedAchievements;
  }

  /**
   * Unlock an achievement for a user (if not already unlocked)
   * Returns the UserAchievement if newly unlocked, null if already had it
   */
  private async unlockAchievement(
    userId: string,
    achievementId: string,
    progress: bigint,
  ): Promise<UserAchievement | null> {
    // Check if already unlocked
    const existing = await this.prisma.userAchievement.findUnique({
      where: {
        userId_achievementId: {
          userId,
          achievementId,
        },
      },
    });

    if (existing) {
      // Update progress if higher
      if (progress > existing.progress) {
        await this.prisma.userAchievement.update({
          where: { id: existing.id },
          data: { progress },
        });
      }
      return null; // Already unlocked
    }

    // Create new unlock
    const userAchievement = await this.prisma.userAchievement.create({
      data: {
        userId,
        achievementId,
        progress,
        unlockedAt: new Date(),
      },
    });

    this.logger.log(`Achievement unlocked: ${achievementId} for user ${userId}`);
    return userAchievement;
  }

  /**
   * Toggle showcase status for an achievement
   */
  async toggleShowcase(
    userId: string,
    achievementId: string,
  ): Promise<UserAchievement | null> {
    const userAchievement = await this.prisma.userAchievement.findUnique({
      where: {
        userId_achievementId: {
          userId,
          achievementId,
        },
      },
    });

    if (!userAchievement) {
      return null;
    }

    return this.prisma.userAchievement.update({
      where: { id: userAchievement.id },
      data: { showcased: !userAchievement.showcased },
    });
  }

  /**
   * Get showcased achievements for a user (for profile display)
   */
  async getShowcasedAchievements(userId: string): Promise<UnlockedAchievement[]> {
    const userAchievements = await this.prisma.userAchievement.findMany({
      where: {
        userId,
        showcased: true,
      },
      include: { achievement: true },
      orderBy: { unlockedAt: 'desc' },
    });

    return userAchievements.map((ua) => ({
      achievement: ua.achievement,
      userAchievement: ua,
    }));
  }

  /**
   * Seed achievement definitions (should be run once or on deployment)
   */
  async seedAchievements(): Promise<void> {
    for (const def of ACHIEVEMENT_DEFINITIONS) {
      await this.prisma.achievement.upsert({
        where: { key: def.key },
        update: {
          name: def.name,
          description: def.description,
          category: def.category,
          iconName: def.iconName,
          tier: def.tier,
          threshold: def.threshold,
        },
        create: def,
      });
    }

    this.logger.log(`Seeded ${ACHIEVEMENT_DEFINITIONS.length} achievements`);
  }
}
