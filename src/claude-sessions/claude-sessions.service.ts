import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
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

interface BufferedSession {
  deviceId: string;
  data: UpsertSessionDto;
  receivedAt: number;
}

interface BufferedMessage {
  deviceId: string;
  sessionKey: string;
  data: StoreMessageDto;
}

export type SessionNamedCallback = (deviceId: string, sessionKey: string, name: string) => void;

const FLUSH_INTERVAL_MS = 2_000;
const MAX_BUFFER_SIZE = 50;
const MAX_CACHE_SIZE = 1_000;

@Injectable()
export class ClaudeSessionsService implements OnModuleDestroy {
  private readonly logger = new Logger(ClaudeSessionsService.name);

  // Write buffers — keyed for last-write-wins dedup
  private sessionBuffer = new Map<string, BufferedSession>();
  private messageBuffer = new Map<string, BufferedMessage>();

  // Cache: `${deviceId}:${sessionKey}` → Prisma row id
  private sessionIdCache = new Map<string, string>();

  private flushTimer: NodeJS.Timeout;
  private isFlushing = false;

  // Callback for when a session gets auto-named
  private onSessionNamedCallback?: SessionNamedCallback;

  constructor(private prisma: PrismaService) {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Register a callback to be invoked when a session is auto-named. */
  onSessionNamed(callback: SessionNamedCallback): void {
    this.onSessionNamedCallback = callback;
  }

  /**
   * Try to set a session name from a user message.
   * Only sets the name if it's currently null (first message wins).
   * Non-blocking — fires and forgets.
   */
  trySetSessionName(deviceId: string, sessionKey: string, content: string): void {
    // Skip tool noise / non-meaningful content
    if (!content || /^\[request interrupted|^\[tool/i.test(content)) return;
    const name = content.slice(0, 100);
    this.prisma.claudeSession.updateMany({
      where: {
        deviceId,
        sessionKey,
        name: null,
      },
      data: { name },
    }).then((result) => {
      if (result.count > 0 && this.onSessionNamedCallback) {
        this.onSessionNamedCallback(deviceId, sessionKey, name);
      }
    }).catch(() => { /* non-critical */ });
  }

  async onModuleDestroy() {
    clearInterval(this.flushTimer);
    await this.flush();
  }

  // ==================== BUFFERED WRITES ====================

  /** Queue a session upsert — will be flushed in the next batch cycle. */
  bufferSessionUpsert(deviceId: string, data: UpsertSessionDto): void {
    const key = `${deviceId}:${data.sessionKey}`;
    this.sessionBuffer.set(key, { deviceId, data, receivedAt: Date.now() });

    if (this.sessionBuffer.size >= MAX_BUFFER_SIZE) {
      void this.flush();
    }
  }

  /** Queue a message store — will be flushed in the next batch cycle. */
  bufferMessageStore(deviceId: string, sessionKey: string, data: StoreMessageDto): void {
    const key = `${deviceId}:${sessionKey}:${data.messageId}`;
    this.messageBuffer.set(key, { deviceId, sessionKey, data });

    if (this.messageBuffer.size >= MAX_BUFFER_SIZE) {
      void this.flush();
    }
  }

  /** Flush all pending buffers to DB. */
  private async flush(): Promise<void> {
    if (this.isFlushing) return;
    if (this.sessionBuffer.size === 0 && this.messageBuffer.size === 0) return;

    this.isFlushing = true;
    try {
      await this.flushSessionBuffer();
      await this.flushMessageBuffer();
    } catch (error) {
      this.logger.error(`Flush error: ${error}`);
    } finally {
      this.isFlushing = false;
    }
  }

  private async flushSessionBuffer(): Promise<void> {
    if (this.sessionBuffer.size === 0) return;

    // Snapshot and clear so new writes go to a fresh buffer
    const entries = [...this.sessionBuffer.values()];
    this.sessionBuffer.clear();

    this.logger.log(`Flushing ${entries.length} session upserts`);

    const ops = entries.map(({ deviceId, data }) => {
      const state = this.mapState(data.state);
      const lastUsedAt = data.lastUsedAt ? new Date(data.lastUsedAt) : new Date();

      const updateData: any = { state, lastUsedAt };
      if (data.directory !== undefined) updateData.directory = data.directory;
      if (data.transcriptPath !== undefined) updateData.transcriptPath = data.transcriptPath;
      if (data.claudeSessionId !== undefined) updateData.claudeSessionId = data.claudeSessionId;

      return this.prisma.claudeSession.upsert({
        where: { deviceId_sessionKey: { deviceId, sessionKey: data.sessionKey } },
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
    });

    try {
      const results = await this.prisma.$transaction(ops);

      // Populate session ID cache from results
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const entry = entries[i];
        const cacheKey = `${entry.deviceId}:${entry.data.sessionKey}`;
        this.sessionIdCache.set(cacheKey, result.id);
      }

      // Evict cache if too large
      if (this.sessionIdCache.size > MAX_CACHE_SIZE) {
        this.sessionIdCache.clear();
      }
    } catch (error) {
      this.logger.error(`Session flush transaction failed: ${error}`);
    }
  }

  private async flushMessageBuffer(): Promise<void> {
    if (this.messageBuffer.size === 0) return;

    // Snapshot and clear
    const entries = [...this.messageBuffer.values()];
    this.messageBuffer.clear();

    this.logger.log(`Flushing ${entries.length} message stores`);

    // Resolve session IDs — try cache first, batch-lookup fallback
    const missingKeys = new Set<string>();
    for (const { deviceId, sessionKey } of entries) {
      const cacheKey = `${deviceId}:${sessionKey}`;
      if (!this.sessionIdCache.has(cacheKey)) {
        missingKeys.add(cacheKey);
      }
    }

    if (missingKeys.size > 0) {
      // Batch lookup all missing session IDs
      const lookupPromises = [...missingKeys].map(async (key) => {
        const [deviceId, sessionKey] = key.split(':');
        const session = await this.getSessionByKey(deviceId, sessionKey);
        if (session) {
          this.sessionIdCache.set(key, session.id);
        }
      });
      await Promise.all(lookupPromises);
    }

    // Build upsert operations for messages that have a resolved session ID
    const ops: ReturnType<typeof this.prisma.claudeSessionMessage.upsert>[] = [];
    for (const { deviceId, sessionKey, data } of entries) {
      const cacheKey = `${deviceId}:${sessionKey}`;
      const sessionId = this.sessionIdCache.get(cacheKey);
      if (!sessionId) {
        this.logger.warn(`Skipping message ${data.messageId}: session not found for ${cacheKey}`);
        continue;
      }

      ops.push(
        this.prisma.claudeSessionMessage.upsert({
          where: { sessionId_messageId: { sessionId, messageId: data.messageId } },
          update: {
            content: data.content,
            toolName: data.toolName,
            toolInput: data.toolInput,
            isError: data.isError ?? false,
          },
          create: {
            sessionId,
            messageId: data.messageId,
            type: data.type,
            content: data.content,
            toolName: data.toolName,
            toolInput: data.toolInput,
            isError: data.isError ?? false,
          },
        }),
      );
    }

    if (ops.length > 0) {
      try {
        await this.prisma.$transaction(ops);

        // Auto-set session name from the first user message
        await this.autoSetSessionNames(entries);
      } catch (error) {
        this.logger.error(`Message flush transaction failed: ${error}`);
      }
    }
  }

  /** For sessions without a name, set it from the first user message content. */
  private async autoSetSessionNames(entries: BufferedMessage[]): Promise<void> {
    // Collect user messages grouped by session cache key
    const userMsgBySession = new Map<string, string>();
    for (const { deviceId, sessionKey, data } of entries) {
      if (data.type === 'user' && data.content) {
        const key = `${deviceId}:${sessionKey}`;
        if (!userMsgBySession.has(key)) {
          userMsgBySession.set(key, data.content);
        }
      }
    }
    if (userMsgBySession.size === 0) return;

    for (const [cacheKey, content] of userMsgBySession) {
      const sessionId = this.sessionIdCache.get(cacheKey);
      if (!sessionId) continue;

      try {
        // Only update if name is still null (first user message wins)
        const result = await this.prisma.claudeSession.updateMany({
          where: { id: sessionId, name: null },
          data: { name: content.slice(0, 100) },
        });

        // Notify gateway so it can broadcast the name to mobile clients
        if (result.count > 0 && this.onSessionNamedCallback) {
          const [deviceId, sessionKey] = cacheKey.split(':');
          this.onSessionNamedCallback(deviceId, sessionKey, content.slice(0, 100));
        }
      } catch {
        // Non-critical — ignore
      }
    }
  }

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
    if (data.directory !== undefined) {
      updateData.directory = data.directory;
    }
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

  // Get unnamed sessions for a device (for backfill)
  async getUnnamedSessions(deviceId: string): Promise<Pick<ClaudeSession, 'id' | 'sessionKey'>[]> {
    return this.prisma.claudeSession.findMany({
      where: { deviceId, name: null },
      select: { id: true, sessionKey: true },
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

    // Auto-set session name from first user message
    if (data.type === 'user' && data.content && !session.name) {
      try {
        await this.prisma.claudeSession.update({
          where: { id: session.id },
          data: { name: data.content.slice(0, 100) },
        });
        if (this.onSessionNamedCallback) {
          this.onSessionNamedCallback(deviceId, sessionKey, data.content.slice(0, 100));
        }
      } catch { /* non-critical */ }
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
