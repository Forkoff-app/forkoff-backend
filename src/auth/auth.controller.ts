import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { AppConfigService } from '../app-config/app-config.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('auth')
@ApiBearerAuth('supabase-auth')
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private appConfigService: AppConfigService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile with app config' })
  @ApiResponse({ status: 200, description: 'Returns the authenticated user profile and app config' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: User, @Req() req: Request) {
    // Extract IP for country detection
    const ip = this.extractIp(req);
    this.logger.log(`/auth/me called for user ${user.id}, IP: ${ip}`);

    // Update country if needed (async, don't wait)
    this.authService.updateCountryFromIp(user.id, ip).catch((err) => {
      this.logger.error('Failed to update country:', err);
    });

    const [profile, versionConfig, subscriptionLimits, cliVersionConfig] = await Promise.all([
      this.authService.getProfile(user.id),
      this.appConfigService.getVersionConfig(),
      this.appConfigService.getSubscriptionLimits(),
      this.appConfigService.getCliVersionConfig(),
    ]);

    return {
      ...profile,
      appConfig: versionConfig,
      subscriptionLimits,
      cliVersionConfig,
    };
  }

  private extractIp(req: Request): string {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string') {
      return forwardedFor.split(',')[0].trim();
    }
    if (Array.isArray(forwardedFor)) {
      return forwardedFor[0];
    }
    return req.ip || '127.0.0.1';
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 400, description: 'Username already taken' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() data: { name?: string; username?: string; avatarUrl?: string },
  ) {
    // Validate username if provided
    if (data.username) {
      const validation = this.authService.validateUsername(data.username);
      if (!validation.valid) {
        throw new BadRequestException(validation.error);
      }

      const available = await this.authService.isUsernameAvailable(data.username, user.id);
      if (!available) {
        throw new BadRequestException('Username is already taken');
      }
    }

    return this.authService.updateProfile(user.id, data);
  }

  @Get('username/check/:username')
  @ApiOperation({ summary: 'Check if username is available' })
  @ApiResponse({ status: 200, description: 'Returns availability status' })
  async checkUsername(
    @CurrentUser() user: User,
    @Param('username') username: string,
  ) {
    const validation = this.authService.validateUsername(username);
    if (!validation.valid) {
      return { available: false, error: validation.error };
    }

    const available = await this.authService.isUsernameAvailable(username, user.id);
    return { available, username };
  }

  @Delete('delete-account')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete current user account' })
  @ApiResponse({ status: 204, description: 'Account deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async deleteAccount(@CurrentUser() user: User) {
    await this.authService.deleteAccount(user.id);
  }
}
