import {
  Controller,
  Post,
  Body,
  UseGuards,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('auth')
@Controller('auth/device')
export class DeviceRegistrationController {
  private readonly logger = new Logger(DeviceRegistrationController.name);

  constructor(private authService: AuthService) {}

  @Post('check-registration')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Check if device is allowed to register or log in' })
  @ApiResponse({ status: 200, description: 'Returns whether access is allowed' })
  async checkRegistration(
    @Body() body: { fingerprintHash: string; email?: string },
  ) {
    if (!body.fingerprintHash || typeof body.fingerprintHash !== 'string') {
      throw new BadRequestException('fingerprintHash is required');
    }

    this.logger.debug(`Device check: hash=${body.fingerprintHash.substring(0, 8)}...`);
    return this.authService.checkDeviceRegistration(body.fingerprintHash, body.email);
  }

  @Post('register-fingerprint')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Register device fingerprint after successful signup' })
  @ApiResponse({ status: 201, description: 'Fingerprint registered' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async registerFingerprint(
    @CurrentUser() user: User,
    @Body() body: { fingerprintHash: string },
  ) {
    if (!body.fingerprintHash || typeof body.fingerprintHash !== 'string') {
      throw new BadRequestException('fingerprintHash is required');
    }

    await this.authService.registerDeviceFingerprint(user.id, body.fingerprintHash);
    return { success: true };
  }
}
