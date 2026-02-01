import {
  Controller,
  Get,
  Post,
  Patch,
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
import { PromptQueueService, QueuePromptDto, UpdateScheduleDto } from './prompt-queue.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('queue')
@Controller('queue')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('supabase-auth')
export class PromptQueueController {
  constructor(private readonly queueService: PromptQueueService) {}

  @Get()
  @ApiOperation({ summary: "Get user's queue" })
  @ApiQuery({
    name: 'includeCompleted',
    required: false,
    description: 'Include completed/failed items',
  })
  @ApiResponse({ status: 200, description: 'Returns queue items' })
  async getUserQueue(
    @CurrentUser() user: User,
    @Query('includeCompleted') includeCompleted?: string,
  ) {
    const items = await this.queueService.getUserQueue(
      user.id,
      includeCompleted === 'true',
    );
    return items;
  }

  @Get('count')
  @ApiOperation({ summary: 'Get pending queue count' })
  @ApiResponse({ status: 200, description: 'Returns pending count' })
  async getPendingCount(@CurrentUser() user: User) {
    const count = await this.queueService.getPendingCount(user.id);
    return { count };
  }

  @Post()
  @ApiOperation({ summary: 'Add prompt to queue' })
  @ApiResponse({ status: 201, description: 'Prompt queued successfully' })
  async queuePrompt(@CurrentUser() user: User, @Body() data: QueuePromptDto) {
    const item = await this.queueService.queuePrompt(user.id, data);
    return item;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a queue item' })
  @ApiParam({ name: 'id', description: 'Queue item ID' })
  @ApiResponse({ status: 200, description: 'Returns queue item' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  async getQueueItem(@CurrentUser() user: User, @Param('id') id: string) {
    return this.queueService.getQueueItem(user.id, id);
  }

  @Patch(':id/priority')
  @ApiOperation({ summary: 'Update item priority' })
  @ApiParam({ name: 'id', description: 'Queue item ID' })
  @ApiResponse({ status: 200, description: 'Priority updated' })
  async reorderQueue(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() data: { priority: number },
  ) {
    return this.queueService.reorderQueue(user.id, id, data.priority);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a queued item' })
  @ApiParam({ name: 'id', description: 'Queue item ID' })
  @ApiResponse({ status: 200, description: 'Item cancelled' })
  async cancelItem(@CurrentUser() user: User, @Param('id') id: string) {
    const item = await this.queueService.cancelItem(user.id, id);
    return { success: true, item };
  }

  @Post('execute-next')
  @ApiOperation({ summary: 'Trigger execution of next pending item' })
  @ApiResponse({ status: 200, description: 'Execution triggered' })
  async executeNext(@CurrentUser() user: User) {
    const item = await this.queueService.getNextPendingItem(user.id);

    if (!item) {
      return { success: false, message: 'No pending items in queue' };
    }

    // Mark as executing (actual execution will be handled by the scheduler/websocket)
    await this.queueService.markExecuting(item.id);

    return {
      success: true,
      item,
      message: 'Item marked for execution',
    };
  }

  // ==================== SCHEDULE ENDPOINTS ====================

  @Get('schedule')
  @ApiOperation({ summary: "Get user's queue schedule" })
  @ApiResponse({ status: 200, description: 'Returns schedule' })
  async getSchedule(@CurrentUser() user: User) {
    const schedule = await this.queueService.getSchedule(user.id);
    return schedule || { enabled: false, scheduledTime: '09:00', daysOfWeek: [] };
  }

  @Patch('schedule')
  @ApiOperation({ summary: 'Update queue schedule' })
  @ApiResponse({ status: 200, description: 'Schedule updated' })
  async updateSchedule(@CurrentUser() user: User, @Body() data: UpdateScheduleDto) {
    return this.queueService.updateSchedule(user.id, data);
  }
}
