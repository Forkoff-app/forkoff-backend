import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptQueueItem, QueueSchedule } from '@prisma/client';

export type QueueItemStatus =
  | 'PENDING'
  | 'SCHEDULED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface QueuePromptDto {
  deviceId: string;
  sessionKey?: string;
  prompt: string;
  rateLimitReason?: string;
  retryAfter?: Date;
  scheduledFor?: Date;
  priority?: number;
}

export interface UpdateScheduleDto {
  enabled?: boolean;
  scheduledTime?: string; // HH:mm format
  daysOfWeek?: number[]; // 0=Sunday, 1=Monday, etc.
}

@Injectable()
export class PromptQueueService {
  private readonly logger = new Logger(PromptQueueService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Add a prompt to the queue
   */
  async queuePrompt(userId: string, data: QueuePromptDto): Promise<PromptQueueItem> {
    const item = await this.prisma.promptQueueItem.create({
      data: {
        userId,
        deviceId: data.deviceId,
        sessionKey: data.sessionKey,
        prompt: data.prompt,
        status: data.scheduledFor ? 'SCHEDULED' : 'PENDING',
        priority: data.priority ?? 0,
        rateLimitReason: data.rateLimitReason,
        retryAfter: data.retryAfter,
        scheduledFor: data.scheduledFor,
      },
    });

    this.logger.log(`Queued prompt for user ${userId}, item ${item.id}`);
    return item;
  }

  /**
   * Get user's queue items
   */
  async getUserQueue(
    userId: string,
    includeCompleted = false,
  ): Promise<PromptQueueItem[]> {
    const where: any = { userId };

    if (!includeCompleted) {
      where.status = {
        in: ['PENDING', 'SCHEDULED', 'EXECUTING'],
      };
    }

    return this.prisma.promptQueueItem.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Get a single queue item
   */
  async getQueueItem(userId: string, itemId: string): Promise<PromptQueueItem> {
    const item = await this.prisma.promptQueueItem.findFirst({
      where: { id: itemId, userId },
    });

    if (!item) {
      throw new NotFoundException('Queue item not found');
    }

    return item;
  }

  /**
   * Update item priority (for reordering)
   */
  async reorderQueue(
    userId: string,
    itemId: string,
    priority: number,
  ): Promise<PromptQueueItem> {
    const item = await this.getQueueItem(userId, itemId);

    if (item.status !== 'PENDING' && item.status !== 'SCHEDULED') {
      throw new Error('Cannot reorder item that is already executing or completed');
    }

    return this.prisma.promptQueueItem.update({
      where: { id: itemId },
      data: { priority },
    });
  }

  /**
   * Cancel a queued item
   */
  async cancelItem(userId: string, itemId: string): Promise<PromptQueueItem> {
    const item = await this.getQueueItem(userId, itemId);

    if (item.status === 'COMPLETED' || item.status === 'FAILED') {
      throw new Error('Cannot cancel completed or failed item');
    }

    return this.prisma.promptQueueItem.update({
      where: { id: itemId },
      data: { status: 'CANCELLED' },
    });
  }

  /**
   * Get next pending item for execution
   */
  async getNextPendingItem(userId: string): Promise<PromptQueueItem | null> {
    return this.prisma.promptQueueItem.findFirst({
      where: {
        userId,
        status: 'PENDING',
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Get scheduled items due for execution
   */
  async getScheduledItemsDue(): Promise<PromptQueueItem[]> {
    const now = new Date();

    return this.prisma.promptQueueItem.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledFor: {
          lte: now,
        },
      },
      orderBy: [{ priority: 'desc' }, { scheduledFor: 'asc' }],
    });
  }

  /**
   * Mark item as executing
   */
  async markExecuting(itemId: string): Promise<PromptQueueItem> {
    return this.prisma.promptQueueItem.update({
      where: { id: itemId },
      data: { status: 'EXECUTING' },
    });
  }

  /**
   * Mark item as completed
   */
  async markCompleted(itemId: string): Promise<PromptQueueItem> {
    return this.prisma.promptQueueItem.update({
      where: { id: itemId },
      data: {
        status: 'COMPLETED',
        executedAt: new Date(),
      },
    });
  }

  /**
   * Mark item as failed
   */
  async markFailed(itemId: string, errorMessage?: string): Promise<PromptQueueItem> {
    return this.prisma.promptQueueItem.update({
      where: { id: itemId },
      data: {
        status: 'FAILED',
        errorMessage,
      },
    });
  }

  /**
   * Delete old completed/failed items (cleanup)
   */
  async cleanupOldItems(daysOld = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.prisma.promptQueueItem.deleteMany({
      where: {
        status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
        updatedAt: { lt: cutoffDate },
      },
    });

    return result.count;
  }

  // ==================== SCHEDULE MANAGEMENT ====================

  /**
   * Get user's queue schedule
   */
  async getSchedule(userId: string): Promise<QueueSchedule | null> {
    return this.prisma.queueSchedule.findUnique({
      where: { userId },
    });
  }

  /**
   * Update user's queue schedule
   */
  async updateSchedule(
    userId: string,
    data: UpdateScheduleDto,
  ): Promise<QueueSchedule> {
    return this.prisma.queueSchedule.upsert({
      where: { userId },
      update: {
        enabled: data.enabled,
        scheduledTime: data.scheduledTime,
        daysOfWeek: data.daysOfWeek,
      },
      create: {
        userId,
        enabled: data.enabled ?? false,
        scheduledTime: data.scheduledTime ?? '09:00',
        daysOfWeek: data.daysOfWeek ?? [],
      },
    });
  }

  /**
   * Get all enabled schedules (for scheduler cron)
   */
  async getEnabledSchedules(): Promise<(QueueSchedule & { user: { timezone: string | null } })[]> {
    return this.prisma.queueSchedule.findMany({
      where: { enabled: true },
      include: {
        user: {
          select: { timezone: true },
        },
      },
    });
  }

  /**
   * Get pending items count for a user
   */
  async getPendingCount(userId: string): Promise<number> {
    return this.prisma.promptQueueItem.count({
      where: {
        userId,
        status: { in: ['PENDING', 'SCHEDULED'] },
      },
    });
  }
}
