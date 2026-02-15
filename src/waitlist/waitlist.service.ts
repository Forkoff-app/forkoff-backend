import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  async addToWaitlist(email: string): Promise<{ success: boolean; message: string }> {
    // Check if email already exists
    const existing = await this.prisma.waitlist.findUnique({
      where: { email },
    });

    if (existing) {
      throw new ConflictException('Email already on waitlist');
    }

    // Add to waitlist
    const entry = await this.prisma.waitlist.create({
      data: { email },
    });

    // Send confirmation email
    const sent = await this.emailService.sendWaitlistConfirmation(email);

    // Update confirmation sent flag
    if (sent) {
      await this.prisma.waitlist.update({
        where: { id: entry.id },
        data: { confirmationSent: true },
      });
    }

    this.logger.log(`Added ${email} to waitlist (confirmation sent: ${sent})`);

    return {
      success: true,
      message: 'Successfully added to waitlist! Check your email for confirmation (don\'t forget to check your junk/spam folder).',
    };
  }

  async grantBetaAccess(email: string): Promise<{ success: boolean; message: string }> {
    const entry = await this.prisma.waitlist.findUnique({
      where: { email },
    });

    if (!entry) {
      return {
        success: false,
        message: 'Email not found in waitlist',
      };
    }

    if (entry.betaAccessSent) {
      return {
        success: false,
        message: 'Beta access already granted to this email',
      };
    }

    // Send beta access email
    const sent = await this.emailService.sendBetaAccessEmail(email);

    // Update beta access sent flag
    if (sent) {
      await this.prisma.waitlist.update({
        where: { id: entry.id },
        data: {
          betaAccessSent: true,
          betaAccessSentAt: new Date(),
        },
      });

      this.logger.log(`Granted beta access to ${email}`);
    }

    return {
      success: sent,
      message: sent ? 'Beta access email sent!' : 'Failed to send beta access email',
    };
  }

  async getWaitlistStats() {
    const [total, confirmed, betaGranted] = await Promise.all([
      this.prisma.waitlist.count(),
      this.prisma.waitlist.count({
        where: { confirmationSent: true },
      }),
      this.prisma.waitlist.count({
        where: { betaAccessSent: true },
      }),
    ]);

    return {
      total,
      confirmed,
      betaGranted,
      pending: total - betaGranted,
    };
  }

  async getWaitlistEntries(page: number = 1, limit: number = 50) {
    const skip = (page - 1) * limit;

    const [entries, total] = await Promise.all([
      this.prisma.waitlist.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.waitlist.count(),
    ]);

    return {
      entries,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Resend confirmation emails to ALL waitlist entries.
   * Resets confirmationSent flag and sends to everyone.
   */
  async resendAllConfirmations(): Promise<{ total: number; sent: number; failed: number }> {
    // Reset all confirmation flags so we re-send to everyone
    await this.prisma.waitlist.updateMany({
      data: { confirmationSent: false },
    });

    const allEntries = await this.prisma.waitlist.findMany({
      orderBy: { createdAt: 'asc' },
    });

    this.logger.log(`Resending confirmation emails to ${allEntries.length} entries...`);

    let sent = 0;
    let failed = 0;

    for (const entry of allEntries) {
      try {
        const success = await this.emailService.sendWaitlistConfirmation(entry.email);
        if (success) {
          await this.prisma.waitlist.update({
            where: { id: entry.id },
            data: { confirmationSent: true },
          });
          sent++;
        } else {
          failed++;
        }
      } catch (error) {
        this.logger.error(`Failed to resend to ${entry.email}:`, error);
        failed++;
      }
    }

    this.logger.log(`Resend complete: ${sent} sent, ${failed} failed out of ${allEntries.length}`);
    return { total: allEntries.length, sent, failed };
  }

  /**
   * Cron job that runs every hour to retry sending confirmation emails
   * to waitlist entries where confirmation email wasn't sent
   */
  @Cron(CronExpression.EVERY_HOUR)
  async retryUnsentConfirmationEmails() {
    this.logger.log('Running hourly check for unsent confirmation emails...');

    // Find entries where confirmation wasn't sent (older than 5 minutes to avoid race conditions)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const unsentEntries = await this.prisma.waitlist.findMany({
      where: {
        confirmationSent: false,
        createdAt: {
          lt: fiveMinutesAgo,
        },
      },
      take: 50, // Process max 50 per run to avoid overload
    });

    if (unsentEntries.length === 0) {
      this.logger.log('No unsent confirmation emails found');
      return;
    }

    this.logger.log(`Found ${unsentEntries.length} entries with unsent confirmation emails`);

    let successCount = 0;
    for (const entry of unsentEntries) {
      try {
        const sent = await this.emailService.sendWaitlistConfirmation(entry.email);
        if (sent) {
          await this.prisma.waitlist.update({
            where: { id: entry.id },
            data: { confirmationSent: true },
          });
          successCount++;
        }
      } catch (error) {
        this.logger.error(`Failed to send confirmation to ${entry.email}:`, error);
      }
    }

    this.logger.log(`Successfully sent ${successCount}/${unsentEntries.length} confirmation emails`);
  }
}
