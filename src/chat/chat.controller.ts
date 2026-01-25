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
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';
import {
  CreateChatSessionDto,
  UpdateChatSessionDto,
  CreateMessageDto,
  CreateApprovalRequestDto,
  RespondApprovalDto,
} from './dto';

@ApiTags('chat')
@ApiBearerAuth('supabase-auth')
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // ==================== CHAT SESSIONS ====================

  @Get('sessions')
  @ApiOperation({ summary: 'Get all chat sessions for the user' })
  @ApiQuery({ name: 'projectId', required: false, description: 'Filter by project ID' })
  @ApiResponse({ status: 200, description: 'Returns list of chat sessions' })
  async getAllSessions(
    @CurrentUser() user: User,
    @Query('projectId') projectId?: string,
  ) {
    if (projectId) {
      return this.chatService.findSessionsByProject(user.id, projectId);
    }
    return this.chatService.findAllSessions(user.id);
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get a chat session with messages' })
  @ApiParam({ name: 'sessionId', description: 'Chat session UUID' })
  @ApiResponse({ status: 200, description: 'Returns chat session with messages' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getSession(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
  ) {
    return this.chatService.findOneSession(user.id, sessionId);
  }

  @Post('sessions')
  @ApiOperation({ summary: 'Create a new chat session' })
  @ApiResponse({ status: 201, description: 'Chat session created' })
  async createSession(
    @CurrentUser() user: User,
    @Body() data: CreateChatSessionDto,
  ) {
    return this.chatService.createSession(user.id, data);
  }

  @Patch('sessions/:sessionId')
  @ApiOperation({ summary: 'Update a chat session (e.g., title)' })
  @ApiParam({ name: 'sessionId', description: 'Chat session UUID' })
  @ApiResponse({ status: 200, description: 'Session updated' })
  async updateSession(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
    @Body() data: UpdateChatSessionDto,
  ) {
    return this.chatService.updateSession(user.id, sessionId, data);
  }

  @Delete('sessions/:sessionId')
  @ApiOperation({ summary: 'Delete a chat session' })
  @ApiParam({ name: 'sessionId', description: 'Chat session UUID' })
  @ApiResponse({ status: 200, description: 'Session deleted' })
  async deleteSession(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
  ) {
    await this.chatService.deleteSession(user.id, sessionId);
    return { success: true };
  }

  // ==================== MESSAGES ====================

  @Get('sessions/:sessionId/messages')
  @ApiOperation({ summary: 'Get messages for a chat session (paginated)' })
  @ApiParam({ name: 'sessionId', description: 'Chat session UUID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Number of messages (default 50)' })
  @ApiQuery({ name: 'before', required: false, description: 'Message ID for pagination' })
  @ApiResponse({ status: 200, description: 'Returns list of messages' })
  async getMessages(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.chatService.getMessages(
      user.id,
      sessionId,
      limit ? parseInt(limit) : 50,
      before,
    );
  }

  @Post('sessions/:sessionId/messages')
  @ApiOperation({ summary: 'Add a message to a chat session' })
  @ApiParam({ name: 'sessionId', description: 'Chat session UUID' })
  @ApiResponse({ status: 201, description: 'Message added' })
  async addMessage(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
    @Body() data: CreateMessageDto,
  ) {
    return this.chatService.addMessage(user.id, sessionId, data);
  }

  // ==================== APPROVAL REQUESTS ====================

  @Get('approvals')
  @ApiOperation({ summary: 'Get all pending approval requests' })
  @ApiResponse({ status: 200, description: 'Returns pending approvals' })
  async getPendingApprovals(@CurrentUser() user: User) {
    return this.chatService.getPendingApprovals(user.id);
  }

  @Post('sessions/:sessionId/messages/:messageId/approval')
  @ApiOperation({ summary: 'Create an approval request for a message' })
  @ApiParam({ name: 'sessionId', description: 'Chat session UUID' })
  @ApiParam({ name: 'messageId', description: 'Message UUID' })
  @ApiResponse({ status: 201, description: 'Approval request created' })
  async createApproval(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
    @Param('messageId') messageId: string,
    @Body() data: CreateApprovalRequestDto,
  ) {
    return this.chatService.createApprovalRequest(
      user.id,
      sessionId,
      messageId,
      data,
    );
  }

  @Post('approvals/:approvalId/respond')
  @ApiOperation({ summary: 'Respond to an approval request (approve/reject)' })
  @ApiParam({ name: 'approvalId', description: 'Approval request UUID' })
  @ApiResponse({ status: 200, description: 'Approval responded' })
  async respondToApproval(
    @CurrentUser() user: User,
    @Param('approvalId') approvalId: string,
    @Body() data: RespondApprovalDto,
  ) {
    return this.chatService.respondToApproval(user.id, approvalId, data);
  }
}
