import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { SubscriptionService } from './subscription.service';
import { UsageResponseDto, LimitCheckResponseDto } from './dto';

@ApiTags('subscription')
@ApiBearerAuth('supabase-auth')
@Controller('subscription')
@UseGuards(JwtAuthGuard)
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('usage')
  @ApiOperation({ summary: 'Get current usage stats' })
  @ApiResponse({ status: 200, type: UsageResponseDto })
  async getUsage(@CurrentUser() user: User): Promise<UsageResponseDto> {
    return this.subscriptionService.getUsageStats(user.id);
  }

  @Post('usage/message')
  @ApiOperation({ summary: 'Record message sent (with limit check)' })
  @ApiResponse({ status: 200, type: LimitCheckResponseDto })
  async recordMessage(@CurrentUser() user: User): Promise<LimitCheckResponseDto> {
    return this.subscriptionService.recordMessageSent(user.id);
  }

  @Post('usage/session')
  @ApiOperation({ summary: 'Record session started (with limit check)' })
  @ApiResponse({ status: 200, type: LimitCheckResponseDto })
  async recordSession(@CurrentUser() user: User): Promise<LimitCheckResponseDto> {
    return this.subscriptionService.recordSessionStarted(user.id);
  }

  @Post('usage/repair')
  @ApiOperation({ summary: 'Record device repair (with limit check)' })
  @ApiResponse({ status: 200, type: LimitCheckResponseDto })
  async recordRepair(@CurrentUser() user: User): Promise<LimitCheckResponseDto> {
    return this.subscriptionService.recordDeviceRepair(user.id);
  }
}
