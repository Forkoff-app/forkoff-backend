import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Request } from 'express';
import { truncateId } from '../../logging/sanitize';

export interface JwtPayload {
  sub: string; // User ID from Supabase
  email: string;
  aud: string;
  role: string;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);
  private supabase: SupabaseClient;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super();

    const supabaseUrl = configService.get<string>('SUPABASE_URL');
    const supabaseServiceKey = configService.get<string>('SUPABASE_SERVICE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
    }

    this.supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    this.logger.log('[JWT] Using Supabase SDK for token verification');
  }

  async validate(req: Request): Promise<any> {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      this.logger.warn('[JWT] No bearer token provided');
      throw new UnauthorizedException('No token provided');
    }

    const token = authHeader.substring(7);
    this.logger.log(`[JWT] Verifying token: [JWT present]`);

    try {
      // Use Supabase to verify the token
      const { data: { user: supabaseUser }, error } = await this.supabase.auth.getUser(token);

      if (error || !supabaseUser) {
        this.logger.error(`[JWT] Token verification failed: ${error?.message || 'No user returned'}`);
        throw new UnauthorizedException('Invalid token');
      }

      this.logger.log(`[JWT] Token verified for Supabase user: ${truncateId(supabaseUser.id)}`);

      // Find or create user in our database
      let user = await this.prisma.user.findUnique({
        where: { id: supabaseUser.id },
      });

      if (!user) {
        this.logger.log(`[JWT] Creating new user in DB: ${truncateId(supabaseUser.id)}`);
        user = await this.prisma.user.create({
          data: {
            id: supabaseUser.id,
            email: supabaseUser.email || '',
          },
        });
      }

      this.logger.log(`[JWT] User validated successfully: ${truncateId(user.id)}`);
      return user;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(`[JWT] Unexpected error during validation: ${error instanceof Error ? error.message : String(error)}`);
      throw new UnauthorizedException('Token validation failed');
    }
  }
}
