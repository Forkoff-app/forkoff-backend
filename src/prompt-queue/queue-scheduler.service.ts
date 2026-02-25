import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PromptQueueService } from './prompt-queue.service';
import { truncateId } from '../logging/sanitize';

/**
 * Scheduler service for executing queued prompts
 * Runs every minute to check for:
 * 1. Scheduled items whose time has come
 * 2. User schedules that match current time
 */
@Injectable()
export class QueueSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(QueueSchedulerService.name);
  private intervalId: NodeJS.Timeout | null = null;

  constructor(private queueService: PromptQueueService) {}

  onModuleInit() {
    // Start the scheduler (runs every minute)
    this.startScheduler();
  }

  private startScheduler() {
    // Run every minute
    this.intervalId = setInterval(() => {
      this.runScheduledTasks().catch((err) => {
        this.logger.error(`Scheduler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 60_000); // 60 seconds

    // Also run once at startup after a short delay
    setTimeout(() => {
      this.runScheduledTasks().catch((err) => {
        this.logger.error(`Initial scheduler run error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 5000);

    this.logger.log('Queue scheduler started');
  }

  /**
   * Main scheduler loop - called every minute
   */
  async runScheduledTasks(): Promise<void> {
    // 1. Process items with specific scheduledFor times
    await this.processScheduledItems();

    // 2. Process user schedules (execute queue at scheduled time)
    await this.processUserSchedules();
  }

  /**
   * Process items that have a specific scheduledFor time
   */
  private async processScheduledItems(): Promise<void> {
    const dueItems = await this.queueService.getScheduledItemsDue();

    for (const item of dueItems) {
      try {
        this.logger.log(`Processing scheduled item ${truncateId(item.id)} for user ${truncateId(item.userId)}`);

        // Mark as executing
        await this.queueService.markExecuting(item.id);

        // TODO: Emit websocket event to execute the prompt
        // This will be handled by the WebSocket gateway integration
        // For now, we just mark it as executing and the mobile app will handle it

        this.logger.log(`Scheduled item ${truncateId(item.id)} marked as executing`);
      } catch (error) {
        this.logger.error(`Failed to process scheduled item ${truncateId(item.id)}: ${error instanceof Error ? error.message : String(error)}`);
        await this.queueService.markFailed(
          item.id,
          error instanceof Error ? error.message : 'Unknown error',
        );
      }
    }
  }

  /**
   * Process user schedules - execute queued items at user's scheduled time
   */
  private async processUserSchedules(): Promise<void> {
    const schedules = await this.queueService.getEnabledSchedules();

    for (const schedule of schedules) {
      try {
        // Check if current time matches user's scheduled time
        if (this.isTimeToExecute(schedule.scheduledTime, schedule.user.timezone, schedule.daysOfWeek)) {
          this.logger.log(`Executing scheduled queue for user ${truncateId(schedule.userId)}`);

          // Get next pending item
          const item = await this.queueService.getNextPendingItem(schedule.userId);

          if (item) {
            await this.queueService.markExecuting(item.id);

            // TODO: Emit websocket event to execute the prompt
            // This will be handled by the WebSocket gateway integration

            this.logger.log(`Queue item ${truncateId(item.id)} triggered for user ${truncateId(schedule.userId)}`);
          }
        }
      } catch (error) {
        this.logger.error(`Failed to process schedule for user ${truncateId(schedule.userId)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Check if current time matches the scheduled time in user's timezone
   */
  private isTimeToExecute(
    scheduledTime: string,
    userTimezone: string | null,
    daysOfWeek: number[],
  ): boolean {
    const tz = userTimezone || 'UTC';

    // Get current time in user's timezone
    const now = new Date();
    const userNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));

    // Check day of week (if specified)
    if (daysOfWeek.length > 0) {
      const currentDay = userNow.getDay();
      if (!daysOfWeek.includes(currentDay)) {
        return false;
      }
    }

    // Parse scheduled time (HH:mm)
    const [scheduledHour, scheduledMinute] = scheduledTime.split(':').map(Number);

    // Compare with current time (within the minute)
    const currentHour = userNow.getHours();
    const currentMinute = userNow.getMinutes();

    return currentHour === scheduledHour && currentMinute === scheduledMinute;
  }

  /**
   * Stop the scheduler (for cleanup)
   */
  stopScheduler(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.logger.log('Queue scheduler stopped');
    }
  }
}
