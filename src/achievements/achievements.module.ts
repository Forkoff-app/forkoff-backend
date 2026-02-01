import { Module } from '@nestjs/common';
import { AchievementsService } from './achievements.service';
import { AchievementsController } from './achievements.controller';
import { AchievementCheckerService } from './achievement-checker.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [PrismaModule, AnalyticsModule],
  providers: [AchievementsService, AchievementCheckerService],
  controllers: [AchievementsController],
  exports: [AchievementsService, AchievementCheckerService],
})
export class AchievementsModule {}
