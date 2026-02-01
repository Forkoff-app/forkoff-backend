import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeoIpService } from '../geo-ip/geo-ip.service';
import { User } from '@prisma/client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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

      this.logger.log(`Updated country for user ${userId}: ${country}`);
    } catch (error) {
      this.logger.error(`Failed to update country for user ${userId}:`, error);
    }
  }

  async deleteAccount(userId: string): Promise<void> {
    this.logger.log(`Deleting account for user: ${userId}`);

    // Delete push tokens first (not cascade-deleted)
    await this.prisma.pushToken.deleteMany({
      where: { userId },
    });

    // Delete the user - cascade deletes will handle related records
    // (devices, projects, chat sessions, etc. all have onDelete: Cascade)
    await this.prisma.user.delete({
      where: { id: userId },
    });

    this.logger.log(`Database records deleted for user: ${userId}`);

    // Delete user from Supabase Auth
    if (this.supabaseAdmin) {
      const { error } = await this.supabaseAdmin.auth.admin.deleteUser(userId);
      if (error) {
        this.logger.error(`Failed to delete user from Supabase Auth: ${error.message}`);
        // Don't throw - database records are already deleted
        // The Supabase auth record will be orphaned but user can't login
      } else {
        this.logger.log(`User deleted from Supabase Auth: ${userId}`);
      }
    }
  }
}
