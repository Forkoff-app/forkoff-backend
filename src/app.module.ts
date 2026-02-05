import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { DevicesModule } from './devices/devices.module';
import { ProjectsModule } from './projects/projects.module';
import { ChatModule } from './chat/chat.module';
import { TerminalModule } from './terminal/terminal.module';
import { GithubModule } from './github/github.module';
import { WebsocketModule } from './websocket/websocket.module';
import { ClaudeSessionsModule } from './claude-sessions/claude-sessions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AppConfigModule } from './app-config/app-config.module';
import { GeoIpModule } from './geo-ip/geo-ip.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AchievementsModule } from './achievements/achievements.module';
import { PromptQueueModule } from './prompt-queue/prompt-queue.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { VouchersModule } from './vouchers/vouchers.module';
import { ReferralsModule } from './referrals/referrals.module';
import { HealthModule } from './health/health.module';

@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Scheduling (for cron jobs)
    ScheduleModule.forRoot(),

    // Rate limiting - 100 requests per 60 seconds per IP
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000, // 1 second
        limit: 10, // 10 requests per second
      },
      {
        name: 'medium',
        ttl: 60000, // 1 minute
        limit: 100, // 100 requests per minute
      },
      {
        name: 'long',
        ttl: 3600000, // 1 hour
        limit: 1000, // 1000 requests per hour
      },
    ]),

    // Database
    PrismaModule,

    // Feature modules
    AuthModule,
    DevicesModule,
    ProjectsModule,
    ChatModule,
    TerminalModule,
    GithubModule,
    ClaudeSessionsModule,
    NotificationsModule,
    AppConfigModule,
    GeoIpModule,
    AnalyticsModule,
    AchievementsModule,
    PromptQueueModule,
    SubscriptionModule,
    VouchersModule,
    ReferralsModule,

    // WebSocket
    WebsocketModule,

    // Health check
    HealthModule,
  ],
})
export class AppModule {}
