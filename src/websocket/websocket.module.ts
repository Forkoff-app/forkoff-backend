import { Module } from '@nestjs/common';
import { WebsocketGateway } from './websocket.gateway';
import { DevicesModule } from '../devices/devices.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeSessionsModule } from '../claude-sessions/claude-sessions.module';

@Module({
  imports: [DevicesModule, AuthModule, ClaudeSessionsModule],
  providers: [WebsocketGateway],
  exports: [WebsocketGateway],
})
export class WebsocketModule {}
