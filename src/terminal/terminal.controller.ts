import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { TerminalService, TerminalSession } from './terminal.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { CreateTerminalSessionDto } from './dto';

@ApiTags('terminal')
@ApiBearerAuth('supabase-auth')
@Controller('terminal')
@UseGuards(JwtAuthGuard)
export class TerminalController {
  constructor(private readonly terminalService: TerminalService) {}

  @Get('sessions')
  @ApiOperation({ summary: 'Get all active terminal sessions' })
  @ApiQuery({ name: 'deviceId', required: false, description: 'Filter by device ID' })
  @ApiResponse({ status: 200, description: 'Returns list of terminal sessions' })
  async getSessions(
    @CurrentUser() user: User,
    @Query('deviceId') deviceId?: string,
  ): Promise<TerminalSession[]> {
    if (deviceId) {
      return this.terminalService.getDeviceSessions(user.id, deviceId);
    }
    return this.terminalService.getUserSessions(user.id);
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get a specific terminal session' })
  @ApiParam({ name: 'sessionId', description: 'Terminal session ID' })
  @ApiResponse({ status: 200, description: 'Returns the terminal session' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getSession(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
  ): Promise<TerminalSession> {
    return this.terminalService.getSession(user.id, sessionId);
  }

  @Post('sessions')
  @ApiOperation({ summary: 'Create a new terminal session on a device' })
  @ApiResponse({ status: 201, description: 'Terminal session created' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async createSession(
    @CurrentUser() user: User,
    @Body() data: CreateTerminalSessionDto,
  ): Promise<TerminalSession> {
    return this.terminalService.createSession(
      user.id,
      data.deviceId,
      data.workingDirectory,
    );
  }

  @Delete('sessions/:sessionId')
  @ApiOperation({ summary: 'Close a terminal session' })
  @ApiParam({ name: 'sessionId', description: 'Terminal session ID' })
  @ApiResponse({ status: 200, description: 'Session closed' })
  async closeSession(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
  ) {
    const closed = this.terminalService.closeSession(user.id, sessionId);
    return { success: closed };
  }
}
