import {
  Controller,
  Get,
  Patch,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { AchievementsService } from './achievements.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('achievements')
@Controller('achievements')
export class AchievementsController {
  constructor(private readonly achievementsService: AchievementsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all achievement definitions' })
  @ApiResponse({ status: 200, description: 'Returns all achievements' })
  async getAllAchievements() {
    const achievements = await this.achievementsService.getAllAchievements();

    // Convert BigInt to string for JSON serialization
    return achievements.map((a) => ({
      ...a,
      threshold: a.threshold.toString(),
    }));
  }

  @Get('user')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Get achievements with user progress' })
  @ApiResponse({ status: 200, description: 'Returns achievements with user progress' })
  async getAchievementsWithProgress(@CurrentUser() user: User) {
    const achievements = await this.achievementsService.getAchievementsWithProgress(
      user.id,
    );

    // Convert BigInt to string for JSON serialization
    return achievements.map((a) => ({
      ...a,
      threshold: a.threshold.toString(),
      userProgress: a.userProgress
        ? {
            ...a.userProgress,
            progress: a.userProgress.progress.toString(),
          }
        : null,
    }));
  }

  @Get('user/unlocked')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: "Get user's unlocked achievements" })
  @ApiResponse({ status: 200, description: 'Returns unlocked achievements' })
  async getUserAchievements(@CurrentUser() user: User) {
    const achievements = await this.achievementsService.getUserAchievements(user.id);

    // Convert BigInt to string for JSON serialization
    return achievements.map((a) => ({
      achievement: {
        ...a.achievement,
        threshold: a.achievement.threshold.toString(),
      },
      unlockedAt: a.userAchievement.unlockedAt,
      progress: a.userAchievement.progress.toString(),
      showcased: a.userAchievement.showcased,
    }));
  }

  @Get('user/showcased')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: "Get user's showcased achievements" })
  @ApiResponse({ status: 200, description: 'Returns showcased achievements' })
  async getShowcasedAchievements(@CurrentUser() user: User) {
    const achievements = await this.achievementsService.getShowcasedAchievements(
      user.id,
    );

    // Convert BigInt to string for JSON serialization
    return achievements.map((a) => ({
      achievement: {
        ...a.achievement,
        threshold: a.achievement.threshold.toString(),
      },
      unlockedAt: a.userAchievement.unlockedAt,
      progress: a.userAchievement.progress.toString(),
      showcased: a.userAchievement.showcased,
    }));
  }

  @Patch(':id/showcase')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Toggle showcase status for an achievement' })
  @ApiParam({ name: 'id', description: 'Achievement ID' })
  @ApiResponse({ status: 200, description: 'Showcase status toggled' })
  @ApiResponse({ status: 404, description: 'Achievement not unlocked' })
  async toggleShowcase(@CurrentUser() user: User, @Param('id') achievementId: string) {
    const result = await this.achievementsService.toggleShowcase(user.id, achievementId);

    if (!result) {
      return { success: false, message: 'Achievement not unlocked' };
    }

    return {
      success: true,
      showcased: result.showcased,
    };
  }

  @Post('seed')
  @ApiOperation({ summary: 'Seed achievement definitions (admin only)' })
  @ApiResponse({ status: 200, description: 'Achievements seeded' })
  async seedAchievements() {
    await this.achievementsService.seedAchievements();
    return { success: true, message: 'Achievements seeded' };
  }
}
