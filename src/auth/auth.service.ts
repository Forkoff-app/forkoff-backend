import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private supabaseAdmin: SupabaseClient;

  constructor(private prisma: PrismaService) {
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
    data: { name?: string; avatarUrl?: string },
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
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
