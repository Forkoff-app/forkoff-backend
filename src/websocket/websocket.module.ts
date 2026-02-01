import { Module } from '@nestjs/common';
import { WebsocketGateway } from './websocket.gateway';
import { DevicesModule } from '../devices/devices.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeSessionsModule } from '../claude-sessions/claude-sessions.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AchievementsModule } from '../achievements/achievements.module';
import { PromptQueueModule } from '../prompt-queue/prompt-queue.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [
    DevicesModule,
    AuthModule,
    ClaudeSessionsModule,
    NotificationsModule,
    AnalyticsModule,
    AchievementsModule,
    PromptQueueModule,
    SubscriptionModule,
  ],
  providers: [WebsocketGateway],
  exports: [WebsocketGateway],
})
export class WebsocketModule {}
