import {
  Controller,
  Get,
  Delete,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ClaudeSessionsService } from './claude-sessions.service';
import { DevicesService } from '../devices/devices.service';

@Controller('claude-sessions')
@UseGuards(JwtAuthGuard)
export class ClaudeSessionsController {
  constructor(
    private readonly claudeSessionsService: ClaudeSessionsService,
    private readonly devicesService: DevicesService,
  ) {}

  // Get all Claude sessions for a device
  @Get('device/:deviceId')
  async getSessionsForDevice(
    @CurrentUser() user: User,
    @Param('deviceId') deviceId: string,
    @Query('active') activeOnly?: string,
  ) {
    // Verify user owns this device
    await this.devicesService.findOne(user.id, deviceId);

    if (activeOnly === 'true') {
      return this.claudeSessionsService.getActiveSessionsForDevice(deviceId);
    }

    return this.claudeSessionsService.getSessionsForDevice(deviceId);
  }

  // Get a specific session
  @Get(':sessionId')
  async getSession(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
  ) {
    const session = await this.claudeSessionsService.getSession(sessionId);

    // Verify user owns the device this session belongs to
    await this.devicesService.findOne(user.id, session.deviceId);

    return session;
  }

  // Delete a session
  @Delete(':sessionId')
  async deleteSession(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
  ) {
    const session = await this.claudeSessionsService.getSession(sessionId);

    // Verify user owns the device this session belongs to
    await this.devicesService.findOne(user.id, session.deviceId);

    await this.claudeSessionsService.deleteSession(sessionId);

    return { success: true };
  }

  // Delete all sessions for a device
  @Delete('device/:deviceId')
  async deleteSessionsForDevice(
    @CurrentUser() user: User,
    @Param('deviceId') deviceId: string,
  ) {
    // Verify user owns this device
    await this.devicesService.findOne(user.id, deviceId);

    const count =
      await this.claudeSessionsService.deleteSessionsForDevice(deviceId);

    return { success: true, count };
  }
}
