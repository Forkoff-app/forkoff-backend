import { Controller, Post, Get, Body, Query, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { WaitlistService } from './waitlist.service';
import { AddToWaitlistDto } from './dto/add-to-waitlist.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

@ApiTags('waitlist')
@Controller('waitlist')
export class WaitlistController {
  constructor(private waitlistService: WaitlistService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 3, ttl: 60000 } }) // 3 requests per minute
  @ApiOperation({ summary: 'Add email to waitlist' })
  @ApiResponse({ status: 201, description: 'Successfully added to waitlist' })
  @ApiResponse({ status: 409, description: 'Email already on waitlist' })
  async addToWaitlist(@Body() dto: AddToWaitlistDto) {
    return this.waitlistService.addToWaitlist(dto.email);
  }

  @Post('grant-beta')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Grant beta access to waitlist email (admin only)' })
  @ApiResponse({ status: 200, description: 'Beta access granted' })
  async grantBetaAccess(@Body() dto: AddToWaitlistDto) {
    return this.waitlistService.grantBetaAccess(dto.email);
  }

  @Post('resend-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Resend confirmation emails to all waitlist entries (admin only)' })
  @ApiResponse({ status: 200, description: 'Resend results' })
  async resendAll() {
    return this.waitlistService.resendAllConfirmations();
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Get waitlist statistics (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns waitlist statistics' })
  async getStats() {
    return this.waitlistService.getWaitlistStats();
  }

  @Get('entries')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Get waitlist entries (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns paginated waitlist entries' })
  async getEntries(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '50',
  ) {
    return this.waitlistService.getWaitlistEntries(
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }
}
