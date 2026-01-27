import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

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

    // WebSocket
    WebsocketModule,
  ],
})
export class AppModule {}
