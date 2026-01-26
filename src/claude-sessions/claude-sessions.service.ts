import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClaudeSession, ClaudeSessionState, ClaudeSessionMessage } from '@prisma/client';

export interface UpsertSessionDto {
  sessionKey: string;
  directory: string;
  state: 'active' | 'inactive' | 'suspended';
  lastUsedAt?: string;
  transcriptPath?: string;
  claudeSessionId?: string;
}

export interface StoreMessageDto {
  messageId: string;
  type: string;
  content?: string;
  toolName?: string;
  toolInput?: any;
  isError?: boolean;
}

@Injectable()
export class ClaudeSessionsService {
  constructor(private prisma: PrismaService) {}

  // Map string state to ClaudeSessionState enum
  private mapState(state: string): ClaudeSessionState {
    const stateMap: Record<string, ClaudeSessionState> = {
      active: ClaudeSessionState.ACTIVE,
      inactive: ClaudeSessionState.INACTIVE,
      suspended: ClaudeSessionState.SUSPENDED,
      ACTIVE: ClaudeSessionState.ACTIVE,
      INACTIVE: ClaudeSessionState.INACTIVE,
      SUSPENDED: ClaudeSessionState.SUSPENDED,
    };
    return stateMap[state] || ClaudeSessionState.INACTIVE;
  }

  // Upsert a Claude session (create or update)
  async upsertSession(
    deviceId: string,
    data: UpsertSessionDto,
  ): Promise<ClaudeSession> {
    const state = this.mapState(data.state);

    const lastUsedAt = data.lastUsedAt ? new Date(data.lastUsedAt) : new Date();

    // Build update object conditionally
    const updateData: any = {
      state,
      lastUsedAt,
    };
    if (data.transcriptPath !== undefined) {
      updateData.transcriptPath = data.transcriptPath;
    }
    if (data.claudeSessionId !== undefined) {
      updateData.claudeSessionId = data.claudeSessionId;
    }

    return this.prisma.claudeSession.upsert({
      where: {
        deviceId_sessionKey: {
          deviceId,
          sessionKey: data.sessionKey,
        },
      },
      update: updateData,
      create: {
        deviceId,
        sessionKey: data.sessionKey,
        directory: data.directory,
        state,
        lastUsedAt,
        transcriptPath: data.transcriptPath,
        claudeSessionId: data.claudeSessionId,
      },
    });
  }

  // Get all sessions for a device
  async getSessionsForDevice(deviceId: string): Promise<ClaudeSession[]> {
    return this.prisma.claudeSession.findMany({
      where: { deviceId },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  // Get active sessions for a device
  async getActiveSessionsForDevice(deviceId: string): Promise<ClaudeSession[]> {
    return this.prisma.claudeSession.findMany({
      where: {
        deviceId,
        state: ClaudeSessionState.ACTIVE,
      },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  // Get a single session
  async getSession(sessionId: string): Promise<ClaudeSession> {
    const session = await this.prisma.claudeSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Claude session not found');
    }

    return session;
  }

  // Get session by session key and device
  async getSessionByKey(
    deviceId: string,
    sessionKey: string,
  ): Promise<ClaudeSession | null> {
    return this.prisma.claudeSession.findUnique({
      where: {
        deviceId_sessionKey: {
          deviceId,
          sessionKey,
        },
      },
    });
  }

  // Update session state
  async updateSessionState(
    sessionId: string,
    state: string,
  ): Promise<ClaudeSession> {
    const mappedState = this.mapState(state);

    return this.prisma.claudeSession.update({
      where: { id: sessionId },
      data: {
        state: mappedState,
        lastUsedAt: new Date(),
      },
    });
  }

  // Delete a session
  async deleteSession(sessionId: string): Promise<void> {
    await this.prisma.claudeSession.delete({
      where: { id: sessionId },
    });
  }

  // Delete all sessions for a device
  async deleteSessionsForDevice(deviceId: string): Promise<number> {
    const result = await this.prisma.claudeSession.deleteMany({
      where: { deviceId },
    });
    return result.count;
  }

  // Mark all sessions for a device as inactive
  async markAllInactive(deviceId: string): Promise<number> {
    const result = await this.prisma.claudeSession.updateMany({
      where: {
        deviceId,
        state: ClaudeSessionState.ACTIVE,
      },
      data: {
        state: ClaudeSessionState.INACTIVE,
      },
    });
    return result.count;
  }

  // ==================== MESSAGE STORAGE ====================

  // Store a message for a session (used for SDK streaming mode)
  async storeMessage(
    deviceId: string,
    sessionKey: string,
    data: StoreMessageDto,
  ): Promise<ClaudeSessionMessage | null> {
    // First get the session
    const session = await this.getSessionByKey(deviceId, sessionKey);
    if (!session) {
      return null;
    }

    // Upsert message (avoid duplicates)
    return this.prisma.claudeSessionMessage.upsert({
      where: {
        sessionId_messageId: {
          sessionId: session.id,
          messageId: data.messageId,
        },
      },
      update: {
        content: data.content,
        toolName: data.toolName,
        toolInput: data.toolInput,
        isError: data.isError ?? false,
      },
      create: {
        sessionId: session.id,
        messageId: data.messageId,
        type: data.type,
        content: data.content,
        toolName: data.toolName,
        toolInput: data.toolInput,
        isError: data.isError ?? false,
      },
    });
  }

  // Get messages for a session (for history)
  async getMessages(
    deviceId: string,
    sessionKey: string,
    limit: number = 100,
    offset: number = 0,
  ): Promise<{ messages: ClaudeSessionMessage[]; total: number }> {
    const session = await this.getSessionByKey(deviceId, sessionKey);
    if (!session) {
      return { messages: [], total: 0 };
    }

    const [messages, total] = await Promise.all([
      this.prisma.claudeSessionMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { timestamp: 'asc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.claudeSessionMessage.count({
        where: { sessionId: session.id },
      }),
    ]);

    return { messages, total };
  }

  // Clear messages for a session (e.g., on /clear command)
  async clearMessages(deviceId: string, sessionKey: string): Promise<number> {
    const session = await this.getSessionByKey(deviceId, sessionKey);
    if (!session) {
      return 0;
    }

    const result = await this.prisma.claudeSessionMessage.deleteMany({
      where: { sessionId: session.id },
    });
    return result.count;
  }
}
