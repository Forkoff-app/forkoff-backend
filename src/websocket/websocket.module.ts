import { Module } from '@nestjs/common';
import { WebsocketGateway } from './websocket.gateway';
import { DevicesModule } from '../devices/devices.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeSessionsModule } from '../claude-sessions/claude-sessions.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [DevicesModule, AuthModule, ClaudeSessionsModule, NotificationsModule],
  providers: [WebsocketGateway],
  exports: [WebsocketGateway],
})
export class WebsocketModule {}
