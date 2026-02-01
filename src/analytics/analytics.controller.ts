import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('supabase-auth')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('usage')
  @ApiOperation({ summary: 'Get aggregated token usage stats' })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['day', 'week', 'month', 'all'],
    description: 'Time period for aggregation',
  })
  @ApiResponse({ status: 200, description: 'Returns usage statistics' })
  async getUsageStats(
    @CurrentUser() user: User,
    @Query('period') period: 'day' | 'week' | 'month' | 'all' = 'all',
  ) {
    const stats = await this.analyticsService.getUserStats(user.id, period);

    // Convert BigInt to string for JSON serialization
    return {
      totalInputTokens: stats.totalInputTokens.toString(),
      totalOutputTokens: stats.totalOutputTokens.toString(),
      totalTokens: stats.totalTokens.toString(),
      totalSessionCount: stats.totalSessionCount,
      estimatedCostUsd: stats.estimatedCostUsd,
      period: stats.period,
    };
  }

  @Get('daily')
  @ApiOperation({ summary: 'Get daily token usage breakdown' })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Start date (ISO format)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'End date (ISO format)',
  })
  @ApiResponse({ status: 200, description: 'Returns daily usage breakdown' })
  async getDailyUsage(
    @CurrentUser() user: User,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    const dailyUsage = await this.analyticsService.getDailyUsage(user.id, start, end);

    // Convert BigInt to string for JSON serialization
    return dailyUsage.map((day) => ({
      date: day.date.toISOString().split('T')[0],
      inputTokens: day.inputTokens.toString(),
      outputTokens: day.outputTokens.toString(),
      totalTokens: (day.inputTokens + day.outputTokens).toString(),
      sessionCount: day.sessionCount,
      estimatedCostUsd: day.estimatedCostUsd,
    }));
  }

  @Get('streak')
  @ApiOperation({ summary: 'Get current activity streak' })
  @ApiResponse({ status: 200, description: 'Returns current streak in days' })
  async getStreak(@CurrentUser() user: User) {
    const streak = await this.analyticsService.getCurrentStreak(user.id);
    const activeDays = await this.analyticsService.getActiveDaysCount(user.id);

    return {
      currentStreak: streak,
      totalActiveDays: activeDays,
    };
  }
}
