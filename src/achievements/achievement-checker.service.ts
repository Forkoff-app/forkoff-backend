import { Injectable, Logger } from '@nestjs/common';
import { AchievementsService, UnlockedAchievement } from './achievements.service';
import { AnalyticsService } from '../analytics/analytics.service';

/**
 * Service for checking and triggering achievement unlocks
 * Should be called after token usage events
 */
@Injectable()
export class AchievementCheckerService {
  private readonly logger = new Logger(AchievementCheckerService.name);

  constructor(
    private achievementsService: AchievementsService,
    private analyticsService: AnalyticsService,
  ) {}

  /**
   * Check all achievements for a user
   * Returns list of newly unlocked achievements
   */
  async checkAllAchievements(userId: string): Promise<UnlockedAchievement[]> {
    const allUnlocked: UnlockedAchievement[] = [];

    try {
      // Get current stats
      const [totalTokens, totalSessions, activeDays, currentStreak] = await Promise.all([
        this.analyticsService.getTotalTokens(userId),
        this.analyticsService.getTotalSessionCount(userId),
        this.analyticsService.getActiveDaysCount(userId),
        this.analyticsService.getCurrentStreak(userId),
      ]);

      // Check token milestones
      const tokenUnlocks = await this.achievementsService.checkTokenMilestones(
        userId,
        totalTokens,
      );
      allUnlocked.push(...tokenUnlocks);

      // Check session milestones
      const sessionUnlocks = await this.achievementsService.checkSessionMilestones(
        userId,
        totalSessions,
      );
      allUnlocked.push(...sessionUnlocks);

      // Check engagement milestones
      const engagementUnlocks = await this.achievementsService.checkEngagementMilestones(
        userId,
        activeDays,
        currentStreak,
      );
      allUnlocked.push(...engagementUnlocks);

      if (allUnlocked.length > 0) {
        this.logger.log(
          `User ${userId} unlocked ${allUnlocked.length} achievements: ${allUnlocked.map((a) => a.achievement.key).join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.error(`Error checking achievements for user ${userId}: ${error}`);
    }

    return allUnlocked;
  }

  /**
   * Quick check for token-based achievements only
   * Use this for immediate feedback after token usage
   */
  async checkTokenAchievements(userId: string): Promise<UnlockedAchievement[]> {
    try {
      const totalTokens = await this.analyticsService.getTotalTokens(userId);
      return this.achievementsService.checkTokenMilestones(userId, totalTokens);
    } catch (error) {
      this.logger.error(`Error checking token achievements: ${error}`);
      return [];
    }
  }
}
