import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
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

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Scheduling (for cron jobs)
    ScheduleModule.forRoot(),

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

    // WebSocket
    WebsocketModule,
  ],
})
export class AppModule {}
