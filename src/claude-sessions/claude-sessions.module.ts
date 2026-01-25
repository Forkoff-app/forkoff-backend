import { Module } from '@nestjs/common';
import { ClaudeSessionsService } from './claude-sessions.service';
import { ClaudeSessionsController } from './claude-sessions.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [PrismaModule, DevicesModule],
  providers: [ClaudeSessionsService],
  controllers: [ClaudeSessionsController],
  exports: [ClaudeSessionsService],
})
export class ClaudeSessionsModule {}
