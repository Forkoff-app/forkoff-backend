import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeoIpService } from '../geo-ip/geo-ip.service';
import { User } from '@prisma/client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { truncateId } from '../logging/sanitize';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private supabaseAdmin: SupabaseClient;

  constructor(
    private prisma: PrismaService,
    private geoIpService: GeoIpService,
  ) {
    // Create Supabase admin client for user management
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (supabaseUrl && supabaseServiceKey) {
      this.supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
    }
  }

  async getProfile(userId: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        devices: {
          include: {
            connectedTools: true,
          },
        },
      },
    });
  }

  async updateProfile(
    userId: string,
    data: { name?: string; username?: string; avatarUrl?: string },
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  validateUsername(username: string): { valid: boolean; error?: string } {
    // Username must be 3-20 characters
    if (username.length < 3) {
      return { valid: false, error: 'Username must be at least 3 characters' };
    }
    if (username.length > 20) {
      return { valid: false, error: 'Username must be at most 20 characters' };
    }

    // Username must start with a letter
    if (!/^[a-zA-Z]/.test(username)) {
      return { valid: false, error: 'Username must start with a letter' };
    }

    // Username can only contain letters, numbers, and underscores
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(username)) {
      return { valid: false, error: 'Username can only contain letters, numbers, and underscores' };
    }

    // Reserved usernames
    const reserved = ['admin', 'root', 'system', 'forkoff', 'support', 'help', 'api', 'www'];
    if (reserved.includes(username.toLowerCase())) {
      return { valid: false, error: 'This username is reserved' };
    }

    return { valid: true };
  }

  async isUsernameAvailable(username: string, excludeUserId?: string): Promise<boolean> {
    const existing = await this.prisma.user.findFirst({
      where: {
        username: { equals: username, mode: 'insensitive' },
        ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
      },
    });
    return !existing;
  }

  async updateCountryFromIp(userId: string, ip: string): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { country: true, countryUpdatedAt: true },
      });

      // Only update if country is not set or hasn't been updated in 24 hours
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (user?.country && user.countryUpdatedAt && user.countryUpdatedAt > twentyFourHoursAgo) {
        return;
      }

      const country = await this.geoIpService.getCountryFromIp(ip);
      if (!country) {
        return;
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          country,
          countryUpdatedAt: new Date(),
        },
      });

      this.logger.log(`Updated country for user ${truncateId(userId)}`);
    } catch (error) {
      this.logger.error(`Failed to update country for user ${truncateId(userId)}:`, error instanceof Error ? error.message : String(error));
    }
  }

  // ==================== DEVICE FINGERPRINT ====================

  /**
   * Check if a device fingerprint is allowed to register or log in.
   * If `email` is provided (login flow), allows access if the fingerprint belongs to that email's account.
   * If no `email` (registration flow), blocks if fingerprint is registered to ANY account within 40 days.
   */
  async checkDeviceRegistration(fingerprintHash: string, email?: string): Promise<{ allowed: boolean; message?: string }> {
    const COOLDOWN_DAYS = 40;
    const cutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    const existing = await this.prisma.deviceFingerprint.findFirst({
      where: {
        fingerprintHash,
        registeredAt: { gte: cutoff },
      },
      orderBy: { registeredAt: 'desc' },
      include: { user: { select: { email: true } } },
    });

    if (existing) {
      // If email provided (login flow), allow if it's the same user's device
      if (email && existing.user.email.toLowerCase() === email.toLowerCase()) {
        return { allowed: true };
      }

      const maskedEmail = this.maskEmail(existing.user.email);
      const message = email
        ? `This device is linked to another account (${maskedEmail}). You can only use one account per device.\n\nIf this is a mistake, contact support.`
        : `You already have an existing account (${maskedEmail}). Please log in instead.\n\nIf this is a mistake, contact support.`;
      return { allowed: false, message };
    }

    return { allowed: true };
  }

  /**
   * Register a device fingerprint for a user after successful signup or login.
   * Skips if this user already has this fingerprint registered (avoids duplicates on repeated logins).
   */
  async registerDeviceFingerprint(userId: string, fingerprintHash: string): Promise<void> {
    // Check if this exact user+fingerprint combo already exists
    const existing = await this.prisma.deviceFingerprint.findFirst({
      where: { userId, fingerprintHash },
    });

    if (existing) {
      // Update the timestamp so the 40-day cooldown is refreshed from latest login
      await this.prisma.deviceFingerprint.update({
        where: { id: existing.id },
        data: { registeredAt: new Date() },
      });
      this.logger.log(`Device fingerprint refreshed for user ${truncateId(userId)}`);
      return;
    }

    await this.prisma.deviceFingerprint.create({
      data: {
        userId,
        fingerprintHash,
      },
    });
    this.logger.log(`Device fingerprint registered for user ${truncateId(userId)}`);
  }

  /**
   * Mask an email address: show first 2 chars of local part + domain.
   * e.g. "john@example.com" → "jo***@example.com"
   */
  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***@***';
    const visible = local.substring(0, 2);
    return `${visible}***@${domain}`;
  }

  async deleteAccount(userId: string): Promise<void> {
    this.logger.log(`Deleting account for user: ${truncateId(userId)}`);

    // Delete push tokens first (not cascade-deleted)
    await this.prisma.pushToken.deleteMany({
      where: { userId },
    });

    // Delete the user - cascade deletes will handle related records
    // (devices, fingerprints, etc. all have onDelete: Cascade)
    await this.prisma.user.delete({
      where: { id: userId },
    });

    this.logger.log(`Database records deleted for user: ${truncateId(userId)}`);

    // Delete user from Supabase Auth
    if (this.supabaseAdmin) {
      const { error } = await this.supabaseAdmin.auth.admin.deleteUser(userId);
      if (error) {
        this.logger.error(`Failed to delete user from Supabase Auth: ${error.message}`);
        // Don't throw - database records are already deleted
        // The Supabase auth record will be orphaned but user can't login
      } else {
        this.logger.log(`User deleted from Supabase Auth: ${truncateId(userId)}`);
      }
    }
  }
}
