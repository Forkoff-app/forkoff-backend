import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateChatSessionDto,
  UpdateChatSessionDto,
  CreateMessageDto,
  CreateApprovalRequestDto,
  RespondApprovalDto,
} from './dto';
import { ApprovalStatus, MessageStatus } from '@prisma/client';

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  // ==================== CHAT SESSIONS ====================

  // Get all chat sessions for a user
  async findAllSessions(userId: string) {
    return this.prisma.chatSession.findMany({
      where: { userId },
      include: {
        project: {
          select: { id: true, name: true },
        },
        _count: {
          select: { messages: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // Get chat sessions for a specific project
  async findSessionsByProject(userId: string, projectId: string) {
    // Verify user owns the project
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return this.prisma.chatSession.findMany({
      where: { userId, projectId },
      include: {
        _count: {
          select: { messages: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // Get a single chat session with messages
  async findOneSession(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
      include: {
        project: {
          select: { id: true, name: true, path: true },
        },
        messages: {
          include: {
            approvalRequest: true,
          },
          orderBy: { timestamp: 'asc' },
        },
      },
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    return session;
  }

  // Create a new chat session
  async createSession(userId: string, data: CreateChatSessionDto) {
    // Verify user owns the project
    const project = await this.prisma.project.findFirst({
      where: { id: data.projectId, userId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return this.prisma.chatSession.create({
      data: {
        userId,
        projectId: data.projectId,
        toolType: data.toolType,
        title: data.title || 'New Chat',
      },
      include: {
        project: {
          select: { id: true, name: true },
        },
      },
    });
  }

  // Update a chat session (title)
  async updateSession(
    userId: string,
    sessionId: string,
    data: UpdateChatSessionDto,
  ) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data,
    });
  }

  // Delete a chat session
  async deleteSession(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    return this.prisma.chatSession.delete({
      where: { id: sessionId },
    });
  }

  // ==================== MESSAGES ====================

  // Add a message to a chat session
  async addMessage(userId: string, sessionId: string, data: CreateMessageDto) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    const message = await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: data.role,
        content: data.content,
        status: MessageStatus.COMPLETE,
      },
    });

    // Update session's updatedAt timestamp
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    return message;
  }

  // Get messages for a chat session (paginated)
  async getMessages(
    userId: string,
    sessionId: string,
    limit = 50,
    before?: string,
  ) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    const whereClause: any = { sessionId };

    if (before) {
      const beforeMessage = await this.prisma.chatMessage.findUnique({
        where: { id: before },
      });
      if (beforeMessage) {
        whereClause.timestamp = { lt: beforeMessage.timestamp };
      }
    }

    return this.prisma.chatMessage.findMany({
      where: whereClause,
      include: {
        approvalRequest: true,
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  // ==================== APPROVAL REQUESTS ====================

  // Create an approval request attached to a message
  async createApprovalRequest(
    userId: string,
    sessionId: string,
    messageId: string,
    data: CreateApprovalRequestDto,
  ) {
    // Verify the message belongs to a session owned by the user
    const message = await this.prisma.chatMessage.findFirst({
      where: {
        id: messageId,
        session: {
          id: sessionId,
          userId,
        },
      },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    return this.prisma.approvalRequest.create({
      data: {
        messageId,
        type: data.type,
        description: data.description,
        changes: data.changes,
      },
    });
  }

  // Get pending approval requests for a user
  async getPendingApprovals(userId: string) {
    return this.prisma.approvalRequest.findMany({
      where: {
        status: ApprovalStatus.PENDING,
        message: {
          session: {
            userId,
          },
        },
      },
      include: {
        message: {
          include: {
            session: {
              select: {
                id: true,
                title: true,
                toolType: true,
                project: {
                  select: { id: true, name: true },
                },
              },
            },
          },
        },
      },
      orderBy: { requestedAt: 'desc' },
    });
  }

  // Respond to an approval request (approve/reject)
  async respondToApproval(
    userId: string,
    approvalId: string,
    data: RespondApprovalDto,
  ) {
    const approval = await this.prisma.approvalRequest.findFirst({
      where: {
        id: approvalId,
        message: {
          session: {
            userId,
          },
        },
      },
    });

    if (!approval) {
      throw new NotFoundException('Approval request not found');
    }

    if (approval.status !== ApprovalStatus.PENDING) {
      throw new ForbiddenException('Approval request already responded to');
    }

    return this.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status: data.status,
        respondedAt: new Date(),
      },
    });
  }
}
