import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DevicesService } from '../devices/devices.service';
import { ClaudeSessionsService } from '../claude-sessions/claude-sessions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AchievementCheckerService } from '../achievements/achievement-checker.service';
import { PromptQueueService } from '../prompt-queue/prompt-queue.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceStatus, MessageRole, ApprovalType } from '@prisma/client';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  deviceId?: string;
  isDevice?: boolean; // true if connection is from CLI tool, false if from mobile app
  clientType?: 'user-scoped' | 'session-scoped'; // Connection scoping type
  sessionId?: string; // Session ID for session-scoped connections
  cliVersion?: string; // CLI version from handshake auth
}

// Chat message payload from AI tool
interface ChatMessagePayload {
  sessionId: string;
  content: string;
  role: MessageRole;
  streaming?: boolean;
  messageId?: string; // for streaming chunks
}

// Approval request payload from AI tool
interface ApprovalRequestPayload {
  sessionId: string;
  messageId: string;
  type: ApprovalType;
  description: string;
  changes: Record<string, unknown>;
}

// Terminal command payload
interface TerminalCommandPayload {
  terminalSessionId: string;
  command: string;
}

// Terminal output payload from device
interface TerminalOutputPayload {
  terminalSessionId: string;
  output: string;
  type: 'stdout' | 'stderr' | 'exit';
  exitCode?: number;
}

// User message payload (SDK-based approach)
interface UserMessagePayload {
  deviceId: string;
  message: string;
  sessionKey?: string;
  directory?: string;
  mode?: {
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    model?: string;
  };
}

// Claude mode change payload
interface ClaudeModeChangePayload {
  deviceId: string;
  sessionKey?: string;
  mode: {
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    model?: string;
  };
}

// Transcript entry structure
interface TranscriptEntryPayload {
  id: string;
  parentId?: string;
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  timestamp: string;
  lineNumber?: number;
  content?: {
    role?: 'user' | 'assistant';
    text?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    isError?: boolean;
    filePath?: string;
    diff?: unknown[];
  };
}

// Transcript history payload from device
interface TranscriptHistoryPayload {
  sessionKey: string;
  entries: TranscriptEntryPayload[];
  totalEntries: number;
  offset: number;
  hasMore: boolean;
}

// Transcript update payload from device
interface TranscriptUpdatePayload {
  sessionKey: string;
  entry: TranscriptEntryPayload;
}

// Claude message payload from device (SDK streaming)
interface ClaudeMessagePayload {
  deviceId: string;
  sessionKey: string;
  message: {
    id: string;
    type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'result';
    content?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    isError?: boolean;
    partial?: boolean;
  };
}

@SkipThrottle()
@WebSocketGateway({
  cors: {
    origin: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'Prod'
      ? (process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || false)
      : true,
  },
  namespace: '/',
  maxHttpBufferSize: 5e6, // 5MB - transcript history payloads can be large
  connectionStateRecovery: {
    maxDisconnectionDuration: 120_000, // 2 minutes - allows brief disconnects to recover seamlessly
    skipMiddlewares: true, // Skip auth re-verification on recovery (session already authenticated)
  },
})
export class WebsocketGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  afterInit() {
    // When a session gets auto-named from its first user message,
    // broadcast the name to mobile clients so the UI updates in real-time.
    this.claudeSessionsService.onSessionNamed((deviceId, sessionKey, name) => {
      this.server.to(`device:${deviceId}`).emit('claude_session_update', {
        deviceId,
        sessionKey,
        name,
        lastUsedAt: new Date().toISOString(),
      });
    });
  }

  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);
  private supabase: SupabaseClient;

  // Track sessions we've already requested name backfill for (avoid repeats)
  private nameBackfillRequested = new Set<string>();

  // Track connected clients
  private userConnections = new Map<string, Set<string>>(); // userId -> Set of socket IDs
  private deviceConnections = new Map<string, string>(); // deviceId -> socket ID
  private sessionConnections = new Map<string, string>(); // sessionId -> socket ID (for session-scoped CLI connections)
  private sessionSockets = new Map<string, Socket>(); // sessionId -> Socket object (direct reference)
  private userCliConnections = new Map<string, Set<string>>(); // userId -> Set of sessionIds (track CLIs by user for cross-device routing)

  // Grace period: delay marking devices OFFLINE to tolerate brief disconnects (e.g., network blips)
  private static readonly DISCONNECT_GRACE_PERIOD_MS = 5_000;
  private disconnectGraceTimers = new Map<string, NodeJS.Timeout>(); // deviceId -> timer

  constructor(
    private configService: ConfigService,
    private devicesService: DevicesService,
    private claudeSessionsService: ClaudeSessionsService,
    private notificationsService: NotificationsService,
    private analyticsService: AnalyticsService,
    private achievementCheckerService: AchievementCheckerService,
    private promptQueueService: PromptQueueService,
    private subscriptionService: SubscriptionService,
    private prisma: PrismaService,
  ) {
    const supabaseUrl = configService.get<string>('SUPABASE_URL');
    const supabaseServiceKey = configService.get<string>('SUPABASE_SERVICE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
    }

    this.supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  async handleConnection(client: AuthenticatedSocket) {
    this.logger.log(`handleConnection start: auth=${JSON.stringify(client.handshake.auth)}`);

    // Connection State Recovery: if the client recovered, restore in-memory maps and skip heavy DB ops
    if ((client as any).recovered) {
      this.logger.log(`Client ${client.id} recovered via Connection State Recovery`);
      const deviceId = client.handshake.auth?.deviceId as string | undefined;
      const sessionId = client.handshake.auth?.sessionId as string | undefined;
      const clientType = client.handshake.auth?.clientType as string | undefined;

      // Restore in-memory tracking maps from handshake auth (rooms are auto-restored by socket.io)
      if (clientType === 'session-scoped' && sessionId) {
        this.sessionConnections.set(sessionId, client.id);
        this.sessionSockets.set(sessionId, client);
      }
      if (deviceId) {
        this.deviceConnections.set(deviceId, client.id);
        // Cancel any pending grace-period disconnect timer
        this.cancelGraceTimer(deviceId);
      }
      if (client.userId) {
        if (!this.userConnections.has(client.userId)) {
          this.userConnections.set(client.userId, new Set());
        }
        this.userConnections.get(client.userId)!.add(client.id);
        if (sessionId && clientType === 'session-scoped') {
          if (!this.userCliConnections.has(client.userId)) {
            this.userCliConnections.set(client.userId, new Set());
          }
          this.userCliConnections.get(client.userId)!.add(sessionId);
        }
      }
      return; // Skip full registration — device status + phone session already up to date
    }

    try {
      // Extract token from handshake
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (token) {
        // Use Supabase SDK to verify the token
        const { data: { user: supabaseUser }, error } = await this.supabase.auth.getUser(token);

        if (error || !supabaseUser) {
          this.logger.warn(`[WS] Token verification failed: ${error?.message || 'No user returned'}`);
        } else {
          client.userId = supabaseUser.id;

          // Track user connection
          if (!this.userConnections.has(supabaseUser.id)) {
            this.userConnections.set(supabaseUser.id, new Set());
          }
          this.userConnections.get(supabaseUser.id)!.add(client.id);

          // Join user's room for targeted broadcasts
          client.join(`user:${supabaseUser.id}`);

          this.logger.log(`User ${supabaseUser.id} connected (socket: ${client.id})`);
        }
      }

      // Handle phone session tracking for user-scoped (mobile) connections
      // Enforced for ALL users — only one mobile device per account
      const clientType = client.handshake.auth?.clientType as 'user-scoped' | 'session-scoped' | undefined;
      if (clientType === 'user-scoped' && client.userId) {
        try {
          const deviceName = (client.handshake.auth?.deviceName as string) || 'Unknown device';

          // Check for existing phone session
          const existingSession = await this.prisma.phoneSession.findUnique({
            where: { userId: client.userId },
          });

          if (existingSession && existingSession.socketId !== client.id) {
            // Auto-kick the old device: emit session_claimed to the OLD socket
            const oldSocket = this.server.sockets.sockets.get(existingSession.socketId);
            if (oldSocket) {
              oldSocket.emit('session_claimed', {
                message: `Your session was claimed by ${deviceName}`,
              });
              // Disconnect old socket after a short delay to ensure the event is delivered
              setTimeout(() => {
                oldSocket.disconnect(true);
              }, 500);
            }

            this.logger.log(
              `Phone session auto-claimed for user ${client.userId}: kicked socket ${existingSession.socketId}, new socket ${client.id}`,
            );
          }

          // Upsert new phone session (always register, whether first or replacement)
          await this.prisma.phoneSession.upsert({
            where: { userId: client.userId },
            update: { socketId: client.id, deviceInfo: deviceName, lastActiveAt: new Date() },
            create: { userId: client.userId, socketId: client.id, deviceInfo: deviceName },
          });
          this.logger.log(`Phone session registered for user ${client.userId} (${deviceName})`);
        } catch (error) {
          this.logger.error(`Error handling phone session: ${error}`);
        }
      }

      // Get session/device info for CLI connections
      const sessionId = client.handshake.auth?.sessionId as string | undefined;
      const deviceId = client.handshake.auth?.deviceId;
      const authUserId = client.handshake.auth?.userId as string | undefined; // userId passed by CLI
      const cliVersion = client.handshake.auth?.cliVersion as string | undefined;

      client.clientType = clientType;
      client.cliVersion = cliVersion;

      // Handle session-scoped connections (CLI per session - the Happy-Reference pattern)
      if (clientType === 'session-scoped' && sessionId) {
        client.sessionId = sessionId;
        client.deviceId = deviceId;
        client.isDevice = true;
        this.sessionConnections.set(sessionId, client.id);
        this.sessionSockets.set(sessionId, client); // Store socket directly

        // Also track by device if provided, and get userId from device if not set via token
        if (deviceId) {
          this.deviceConnections.set(deviceId, client.id);
          this.cancelGraceTimer(deviceId); // Cancel pending offline transition from previous disconnect

          // Get device metadata from handshake headers
          const deviceName = client.handshake.headers['x-device-name'] as string || 'CLI Device';
          const devicePlatform = client.handshake.headers['x-device-platform'] as string || 'windows';
          const deviceHostname = client.handshake.headers['x-device-hostname'] as string || undefined;

          try {
            const device = await this.devicesService.updateStatus(deviceId, DeviceStatus.ONLINE);
            // Set client.userId from device if not already set via token
            if (!client.userId && device.userId && device.userId !== 'pending') {
              client.userId = device.userId;
              // Also add to user connections
              if (!this.userConnections.has(device.userId)) {
                this.userConnections.set(device.userId, new Set());
              }
              this.userConnections.get(device.userId)!.add(client.id);
              client.join(`user:${device.userId}`);
              this.logger.log(`Set client.userId from device: ${device.userId}`);
            }
            // Notify user that device/session is active
            if (device.userId && device.userId !== 'pending') {
              this.server.to(`user:${device.userId}`).emit('device_status', {
                deviceId,
                status: DeviceStatus.ONLINE,
                cliVersion,
              });
              this.server.to(`user:${device.userId}`).emit('session_connected', {
                deviceId,
                sessionId,
              });
            }
          } catch (error) {
            this.logger.error(`Error updating device status: ${error}`);

            // Auto-register device if it doesn't exist but we have a valid userId
            const effectiveUserId = client.userId || authUserId;
            if (effectiveUserId) {
              this.logger.log(`Auto-registering device ${deviceId} for user ${effectiveUserId}`);
              try {
                const newDevice = await this.devicesService.autoRegister(deviceId, effectiveUserId, {
                  name: deviceName,
                  platform: devicePlatform,
                  hostname: deviceHostname,
                  type: 'desktop',
                });
                this.logger.log(`Device ${deviceId} auto-registered successfully`);

                // Set client.userId if not already set
                if (!client.userId) {
                  client.userId = effectiveUserId;
                  if (!this.userConnections.has(effectiveUserId)) {
                    this.userConnections.set(effectiveUserId, new Set());
                  }
                  this.userConnections.get(effectiveUserId)!.add(client.id);
                  client.join(`user:${effectiveUserId}`);
                }

                // Notify user that device/session is active
                this.server.to(`user:${effectiveUserId}`).emit('device_status', {
                  deviceId,
                  status: DeviceStatus.ONLINE,
                  cliVersion,
                });
                this.server.to(`user:${effectiveUserId}`).emit('session_connected', {
                  deviceId,
                  sessionId,
                });
              } catch (autoRegisterError) {
                this.logger.error(`Failed to auto-register device: ${autoRegisterError}`);
                // Still set userId from CLI auth as fallback
                if (!client.userId && authUserId) {
                  client.userId = authUserId;
                  if (!this.userConnections.has(authUserId)) {
                    this.userConnections.set(authUserId, new Set());
                  }
                  this.userConnections.get(authUserId)!.add(client.id);
                  client.join(`user:${authUserId}`);
                  this.logger.log(`Set client.userId from CLI auth (auto-register failed): ${authUserId}`);
                }
              }
            } else {
              this.logger.warn(`Cannot auto-register device ${deviceId}: no userId available`);
            }
          }
        }

        // If no deviceId but userId passed by CLI, use that
        if (!client.userId && authUserId) {
          client.userId = authUserId;
          if (!this.userConnections.has(authUserId)) {
            this.userConnections.set(authUserId, new Set());
          }
          this.userConnections.get(authUserId)!.add(client.id);
          client.join(`user:${authUserId}`);
          this.logger.log(`Set client.userId from CLI auth: ${authUserId}`);
        }

        // Join session-specific room
        client.join(`session:${sessionId}`);

        // Also join device room for backward compatibility
        if (deviceId) {
          client.join(`device:${deviceId}`);
        }

        this.logger.log(`Session-scoped CLI connected: session=${sessionId}, device=${deviceId}, userId=${client.userId} (socket: ${client.id})`);

        // Track by userId for cross-device routing (allows mobile to find CLI regardless of deviceId)
        if (client.userId) {
          if (!this.userCliConnections.has(client.userId)) {
            this.userCliConnections.set(client.userId, new Set());
          }
          this.userCliConnections.get(client.userId)!.add(sessionId);
          this.logger.log(`Added CLI session ${sessionId} to user ${client.userId}'s CLI connections`);
        }
      }
      // Handle legacy device-scoped connections
      else if (deviceId) {
        client.deviceId = deviceId;
        client.isDevice = true;
        this.deviceConnections.set(deviceId, client.id);
        this.cancelGraceTimer(deviceId); // Cancel pending offline transition from previous disconnect

        // Join device room
        client.join(`device:${deviceId}`);

        // Get device metadata from handshake headers
        const deviceName = client.handshake.headers['x-device-name'] as string || 'CLI Device';
        const devicePlatform = client.handshake.headers['x-device-platform'] as string || 'windows';
        const deviceHostname = client.handshake.headers['x-device-hostname'] as string || undefined;

        try {
          // Update device status to online
          const device = await this.devicesService.updateStatus(deviceId, DeviceStatus.ONLINE);

          // Notify user that device is online
          if (device.userId && device.userId !== 'pending') {
            this.server.to(`user:${device.userId}`).emit('device_status', {
              deviceId,
              status: DeviceStatus.ONLINE,
              cliVersion,
            });
          }
        } catch (error) {
          this.logger.error(`Error updating device status: ${error}`);

          // Auto-register device if it doesn't exist but we have a valid userId
          const effectiveUserId = client.userId || authUserId;
          if (effectiveUserId) {
            this.logger.log(`Auto-registering device ${deviceId} for user ${effectiveUserId}`);
            try {
              const newDevice = await this.devicesService.autoRegister(deviceId, effectiveUserId, {
                name: deviceName,
                platform: devicePlatform,
                hostname: deviceHostname,
                type: 'desktop',
              });
              this.logger.log(`Device ${deviceId} auto-registered successfully`);

              // Set client.userId if not already set
              if (!client.userId) {
                client.userId = effectiveUserId;
                if (!this.userConnections.has(effectiveUserId)) {
                  this.userConnections.set(effectiveUserId, new Set());
                }
                this.userConnections.get(effectiveUserId)!.add(client.id);
                client.join(`user:${effectiveUserId}`);
              }

              // Notify user that device is online
              this.server.to(`user:${effectiveUserId}`).emit('device_status', {
                deviceId,
                status: DeviceStatus.ONLINE,
                cliVersion,
              });
            } catch (autoRegisterError) {
              this.logger.error(`Failed to auto-register device: ${autoRegisterError}`);
            }
          } else {
            this.logger.warn(`Cannot auto-register device ${deviceId}: no userId available`);
          }
        }

        this.logger.log(`Device ${deviceId} connected (socket: ${client.id})`);
      }
    } catch (error) {
      this.logger.error(`Connection error: ${error}`);
      // Don't disconnect - allow anonymous connections for initial pairing
    }
  }

  async handleDisconnect(client: AuthenticatedSocket) {
    // Remove from user connections
    if (client.userId) {
      const userSockets = this.userConnections.get(client.userId);
      if (userSockets) {
        userSockets.delete(client.id);
        if (userSockets.size === 0) {
          this.userConnections.delete(client.userId);
        }
      }
      this.logger.log(
        `User ${client.userId} disconnected (socket: ${client.id})`,
      );
    }

    // Handle session-scoped disconnection
    if (client.sessionId) {
      this.sessionConnections.delete(client.sessionId);
      this.sessionSockets.delete(client.sessionId); // Remove socket reference

      // Clean up userCliConnections
      if (client.userId) {
        const userSessions = this.userCliConnections.get(client.userId);
        if (userSessions) {
          userSessions.delete(client.sessionId);
          if (userSessions.size === 0) {
            this.userCliConnections.delete(client.userId);
          }
          this.logger.log(`Removed CLI session ${client.sessionId} from user ${client.userId}'s CLI connections`);
        }
      }

      this.logger.log(
        `Session ${client.sessionId} disconnected (socket: ${client.id})`,
      );

      // Notify user about session disconnection
      if (client.deviceId) {
        try {
          const device = await this.devicesService.updateStatus(
            client.deviceId,
            DeviceStatus.ONLINE, // Device may still be online, just this session ended
          );
          if (device.userId && device.userId !== 'pending') {
            this.server.to(`user:${device.userId}`).emit('session_disconnected', {
              deviceId: client.deviceId,
              sessionId: client.sessionId,
            });
          }
        } catch (error) {
          this.logger.error(`Error handling session disconnect: ${error}`);
        }
      }
    }

    // Handle device disconnection — use grace period to tolerate brief network blips
    if (client.deviceId) {
      const disconnectedDeviceId = client.deviceId;
      const disconnectedCliVersion = client.cliVersion;

      // Remove stale socket mapping (reconnect will re-add with new socket ID)
      this.deviceConnections.delete(disconnectedDeviceId);

      this.logger.log(
        `Device ${disconnectedDeviceId} disconnected — starting ${WebsocketGateway.DISCONNECT_GRACE_PERIOD_MS}ms grace period`,
      );

      // Cancel any existing grace timer (handles rapid disconnect/reconnect cycles)
      this.cancelGraceTimer(disconnectedDeviceId);

      // Start grace period timer — only mark OFFLINE if device doesn't reconnect
      const timer = setTimeout(async () => {
        this.disconnectGraceTimers.delete(disconnectedDeviceId);

        // Check if device has already reconnected during grace period
        if (this.deviceConnections.has(disconnectedDeviceId)) {
          this.logger.log(`Device ${disconnectedDeviceId} reconnected during grace period — skipping offline transition`);
          return;
        }

        // Device didn't reconnect — proceed with offline transition
        this.logger.log(`Grace period expired for device ${disconnectedDeviceId} — marking OFFLINE`);

        try {
          const device = await this.devicesService.updateStatus(
            disconnectedDeviceId,
            DeviceStatus.OFFLINE,
          );

          // Mark all Claude sessions as inactive when device goes offline
          try {
            const { count, sessionKeys } = await this.claudeSessionsService.markAllInactive(disconnectedDeviceId);
            if (count > 0) {
              this.logger.log(`Marked ${count} session(s) inactive for device ${disconnectedDeviceId}`);
              // Notify mobile clients so they update in-memory state
              if (device.userId && device.userId !== 'pending') {
                for (const sessionKey of sessionKeys) {
                  this.sendToUser(device.userId, 'claude_session_update', {
                    sessionKey,
                    deviceId: disconnectedDeviceId,
                    state: 'inactive',
                    lastUsedAt: new Date().toISOString(),
                  });
                }
              }
            }
          } catch (error) {
            this.logger.error(`Error marking sessions inactive: ${error}`);
          }

          // Notify user that device is offline
          if (device.userId && device.userId !== 'pending') {
            this.server.to(`user:${device.userId}`).emit('device_status', {
              deviceId: disconnectedDeviceId,
              status: DeviceStatus.OFFLINE,
              cliVersion: disconnectedCliVersion,
            });
          }
        } catch (error) {
          this.logger.error(`Error updating device status: ${error}`);
        }
      }, WebsocketGateway.DISCONNECT_GRACE_PERIOD_MS);

      this.disconnectGraceTimers.set(disconnectedDeviceId, timer);

      this.logger.log(
        `Device ${client.deviceId} disconnected (socket: ${client.id})`,
      );
    }

    // Clean up phone session for user-scoped connections
    if (client.userId && client.clientType === 'user-scoped') {
      try {
        await this.prisma.phoneSession.deleteMany({
          where: { userId: client.userId, socketId: client.id },
        });
        this.logger.log(`Phone session cleaned up for user ${client.userId}`);
      } catch (error) {
        this.logger.error(`Failed to clean phone session: ${error}`);
      }

      // Notify CLI sessions that mobile user disconnected
      // so they can clear taken-over state and revert to watch-only
      const cliSessions = this.userCliConnections.get(client.userId);
      if (cliSessions && cliSessions.size > 0) {
        const payload = {
          userId: client.userId,
          timestamp: new Date().toISOString(),
        };
        for (const cliSessionId of cliSessions) {
          this.sendToSession(cliSessionId, 'mobile_disconnected', payload);
        }
        this.logger.log(`Notified ${cliSessions.size} CLI session(s) of mobile disconnect for user ${client.userId}`);
      }
    }
  }

  // Mobile app subscribes to device updates
  @SubscribeMessage('subscribe_device')
  handleSubscribeDevice(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    client.join(`device:${data.deviceId}`);
    this.logger.log(`Socket ${client.id} subscribed to device ${data.deviceId}`);
    return { success: true };
  }

  @SubscribeMessage('unsubscribe_device')
  handleUnsubscribeDevice(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    client.leave(`device:${data.deviceId}`);
    return { success: true };
  }

  // Claim phone session (take over from another device)
  @SubscribeMessage('claim_phone_session')
  async handleClaimPhoneSession(
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    try {
      const existingSession = await this.prisma.phoneSession.findUnique({
        where: { userId: client.userId },
      });

      if (existingSession) {
        // Disconnect the old session
        const oldSocket = this.server.sockets.sockets.get(
          existingSession.socketId,
        );
        if (oldSocket) {
          oldSocket.emit('session_claimed', {
            message: 'Session taken over by another device',
          });
          oldSocket.disconnect(true);
        }
      }

      // Register new session
      await this.prisma.phoneSession.upsert({
        where: { userId: client.userId },
        update: { socketId: client.id, lastActiveAt: new Date() },
        create: { userId: client.userId, socketId: client.id },
      });

      this.logger.log(`Phone session claimed by user ${client.userId}`);
      client.emit('claim_phone_session_result', { success: true });

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to claim phone session: ${error}`);
      return { error: 'Failed to claim session' };
    }
  }

  // Map string status to DeviceStatus enum
  private mapDeviceStatus(status: string | undefined): DeviceStatus {
    if (!status) return DeviceStatus.ONLINE;
    const statusMap: Record<string, DeviceStatus> = {
      online: DeviceStatus.ONLINE,
      offline: DeviceStatus.OFFLINE,
      syncing: DeviceStatus.SYNCING,
      ONLINE: DeviceStatus.ONLINE,
      OFFLINE: DeviceStatus.OFFLINE,
      SYNCING: DeviceStatus.SYNCING,
    };
    return statusMap[status] || DeviceStatus.ONLINE;
  }

  // Device sends status update
  @SubscribeMessage('device_heartbeat')
  async handleDeviceHeartbeat(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { status?: string },
  ): Promise<{ success: true } | { error: string }> {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    const status = this.mapDeviceStatus(data.status);
    const device = await this.devicesService.updateStatus(
      client.deviceId,
      status,
    );

    // Notify user of status update
    if (device.userId && device.userId !== 'pending') {
      this.server.to(`user:${device.userId}`).emit('device_status', {
        deviceId: client.deviceId,
        status,
        lastSeenAt: device.lastSeenAt,
        cliVersion: client.cliVersion,
      });
    }

    return { success: true };
  }

  // Device syncing status
  @SubscribeMessage('device_syncing')
  async handleDeviceSyncing(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { syncing: boolean },
  ): Promise<{ success: true } | { error: string }> {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    const status = data.syncing ? DeviceStatus.SYNCING : DeviceStatus.ONLINE;
    const device = await this.devicesService.updateStatus(
      client.deviceId,
      status,
    );

    // Notify user
    if (device.userId && device.userId !== 'pending') {
      this.server.to(`user:${device.userId}`).emit('device_status', {
        deviceId: client.deviceId,
        status,
        cliVersion: client.cliVersion,
      });
    }

    return { success: true };
  }

  // Cancel a pending disconnect grace timer for a device (called on reconnect/recovery)
  private cancelGraceTimer(deviceId: string): void {
    const existing = this.disconnectGraceTimers.get(deviceId);
    if (existing) {
      clearTimeout(existing);
      this.disconnectGraceTimers.delete(deviceId);
      this.logger.log(`Cancelled disconnect grace timer for device ${deviceId}`);
    }
  }

  // Helper method to send to specific user
  sendToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  // Helper method to send to specific device
  sendToDevice(deviceId: string, event: string, data: unknown): void {
    this.logger.log(`sendToDevice: ${event} to device:${deviceId}`);
    this.server.to(`device:${deviceId}`).emit(event, data);
  }

  // Helper method to send to specific session (session-scoped CLI connection)
  sendToSession(sessionId: string, event: string, data: unknown): void {
    this.logger.log(`sendToSession: ${event} to session:${sessionId}`);
    this.server.to(`session:${sessionId}`).emit(event, data);
  }

  // Helper method to emit to session - sends to both session-scoped CLI and user-scoped mobile
  emitToSession(sessionId: string, event: string, data: unknown, userId?: string): void {
    // Send to session-scoped CLI
    this.server.to(`session:${sessionId}`).emit(event, data);

    // Also send to transcript room for mobile clients watching this session
    this.server.to(`transcript:${sessionId}`).emit(event, data);

    // If userId provided, also send to user's general channel
    if (userId) {
      this.server.to(`user:${userId}`).emit(event, data);
    }
  }

  // Check if user is online
  isUserOnline(userId: string): boolean {
    return (
      this.userConnections.has(userId) &&
      this.userConnections.get(userId)!.size > 0
    );
  }

  // Check if device is online
  isDeviceOnline(deviceId: string): boolean {
    return this.deviceConnections.has(deviceId);
  }

  // Check if session is connected
  isSessionConnected(sessionId: string): boolean {
    return this.sessionConnections.has(sessionId);
  }

  // Get socket for session
  getSessionSocket(sessionId: string): Socket | undefined {
    // Use directly stored socket reference (like Happy does)
    const socket = this.sessionSockets.get(sessionId);
    this.logger.debug(`getSessionSocket: sessionId=${sessionId}, hasSocket=${!!socket}, connected=${socket?.connected}, sessionSocketsKeys=${JSON.stringify(Array.from(this.sessionSockets.keys()))}`);
    if (socket && socket.connected) {
      return socket;
    }
    return undefined;
  }

  // ==================== CHAT EVENTS ====================

  // Subscribe to a chat session for real-time updates
  @SubscribeMessage('chat_subscribe')
  handleChatSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { sessionId: string },
  ) {
    client.join(`chat:${data.sessionId}`);
    this.logger.log(`Socket ${client.id} subscribed to chat ${data.sessionId}`);
    return { success: true };
  }

  @SubscribeMessage('chat_unsubscribe')
  handleChatUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { sessionId: string },
  ) {
    client.leave(`chat:${data.sessionId}`);
    return { success: true };
  }

  // Device sends chat message (from AI tool)
  @SubscribeMessage('chat_message')
  handleChatMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ChatMessagePayload,
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Broadcast to all subscribers of this chat session
    this.server.to(`chat:${data.sessionId}`).emit('chat_message', {
      sessionId: data.sessionId,
      content: data.content,
      role: data.role,
      messageId: data.messageId,
      streaming: data.streaming,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  // Device sends streaming chunk
  @SubscribeMessage('chat_stream')
  handleChatStream(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      sessionId: string;
      messageId: string;
      chunk: string;
      done?: boolean;
    },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    this.server.to(`chat:${data.sessionId}`).emit('chat_stream', {
      sessionId: data.sessionId,
      messageId: data.messageId,
      chunk: data.chunk,
      done: data.done,
    });

    return { success: true };
  }

  // Device sends approval request
  @SubscribeMessage('approval_request')
  handleApprovalRequest(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ApprovalRequestPayload,
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Broadcast to chat session subscribers and also to user's general channel
    this.server.to(`chat:${data.sessionId}`).emit('approval_request', {
      ...data,
      deviceId: client.deviceId,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  // Mobile app responds to approval request
  @SubscribeMessage('approval_response')
  handleApprovalResponse(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      approvalId: string;
      sessionId: string;
      status: 'APPROVED' | 'REJECTED';
      deviceId: string;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Send response to the device
    this.sendToDevice(data.deviceId, 'approval_response', {
      approvalId: data.approvalId,
      sessionId: data.sessionId,
      status: data.status,
      respondedBy: client.userId,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  // ==================== TERMINAL EVENTS ====================

  // Mobile app requests to create/initialize a terminal session on device
  @SubscribeMessage('terminal_create')
  handleTerminalCreate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { terminalSessionId: string; deviceId: string; cwd: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Forward to device to create the terminal session
    this.sendToDevice(data.deviceId, 'terminal_create', {
      terminalSessionId: data.terminalSessionId,
      cwd: data.cwd,
      requestedBy: client.userId,
    });

    this.logger.log(
      `Terminal create request sent to device ${data.deviceId} for session ${data.terminalSessionId}`,
    );
    return { success: true };
  }

  // Subscribe to a terminal session
  @SubscribeMessage('terminal_subscribe')
  handleTerminalSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { terminalSessionId: string },
  ) {
    client.join(`terminal:${data.terminalSessionId}`);
    this.logger.log(
      `Socket ${client.id} subscribed to terminal ${data.terminalSessionId}`,
    );
    return { success: true };
  }

  @SubscribeMessage('terminal_unsubscribe')
  handleTerminalUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { terminalSessionId: string },
  ) {
    client.leave(`terminal:${data.terminalSessionId}`);
    return { success: true };
  }

  // Mobile app sends command to device
  @SubscribeMessage('terminal_command')
  handleTerminalCommand(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: TerminalCommandPayload & { deviceId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Forward command to the device
    this.sendToDevice(data.deviceId, 'terminal_command', {
      terminalSessionId: data.terminalSessionId,
      command: data.command,
      deviceId: data.deviceId,
      requestedBy: client.userId,
    });

    this.logger.log(
      `Command sent to device ${data.deviceId}: ${data.command.substring(0, 50)}`,
    );
    return { success: true };
  }

  // Mobile app sends user message to Claude session (SDK-based approach)
  @SubscribeMessage('user_message')
  async handleUserMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: UserMessagePayload,
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Check message limit
    const result = await this.subscriptionService.recordMessageSent(
      client.userId,
    );
    if (!result.allowed) {
      client.emit('limit_reached', {
        limitType: 'messages_daily',
        currentUsage: result.currentUsage,
        limit: result.limit,
        resetAt: result.resetAt,
      });
      return { error: 'MESSAGE_LIMIT_REACHED' };
    }

    const payload = {
      deviceId: data.deviceId,
      message: data.message,
      sessionKey: data.sessionKey,
      directory: data.directory,
      mode: data.mode,
    };

    // Prefer session-scoped routing if sessionKey is provided and session is connected
    if (data.sessionKey && this.isSessionConnected(data.sessionKey)) {
      this.sendToSession(data.sessionKey, 'user_message', payload);
      this.logger.log(
        `User message sent to session ${data.sessionKey}: ${data.message.substring(0, 50)}`,
      );
    } else {
      // Fallback to device routing
      this.sendToDevice(data.deviceId, 'user_message', payload);
      this.logger.log(
        `User message sent to device ${data.deviceId}: ${data.message.substring(0, 50)}`,
      );
    }

    return { success: true };
  }

  // Mobile app sends abort request
  @SubscribeMessage('claude_abort')
  handleClaudeAbort(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string; sessionKey?: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.sendToDevice(data.deviceId, 'claude_abort', {
      deviceId: data.deviceId,
      sessionKey: data.sessionKey,
    });

    this.logger.log(`Abort request sent to device ${data.deviceId}`);
    return { success: true };
  }

  // Mobile app sends mode change request
  @SubscribeMessage('claude_mode_change')
  handleClaudeModeChange(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ClaudeModeChangePayload,
  ): { success: true } | { error: string } {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.sendToDevice(data.deviceId, 'claude_mode_change', {
      deviceId: data.deviceId,
      sessionKey: data.sessionKey,
      mode: data.mode,
    });

    this.logger.log(`Mode change sent to device ${data.deviceId}`);
    return { success: true };
  }

  // Device sends terminal output
  @SubscribeMessage('terminal_output')
  handleTerminalOutput(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: TerminalOutputPayload,
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Broadcast output to terminal session subscribers
    this.server.to(`terminal:${data.terminalSessionId}`).emit('terminal_output', {
      terminalSessionId: data.terminalSessionId,
      output: data.output,
      type: data.type,
      exitCode: data.exitCode,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  // Device notifies working directory changed
  @SubscribeMessage('terminal_cwd')
  handleTerminalCwd(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { terminalSessionId: string; cwd: string },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    this.server.to(`terminal:${data.terminalSessionId}`).emit('terminal_cwd', {
      terminalSessionId: data.terminalSessionId,
      cwd: data.cwd,
    });

    return { success: true };
  }

  // ==================== PROJECT/FILE EVENTS ====================

  // Device notifies file changes
  @SubscribeMessage('file_changed')
  handleFileChanged(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      projectId: string;
      filePath: string;
      changeType: 'created' | 'modified' | 'deleted';
    },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Broadcast to project subscribers
    this.server.to(`project:${data.projectId}`).emit('file_changed', {
      ...data,
      deviceId: client.deviceId,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  // Subscribe to project file changes
  @SubscribeMessage('project_subscribe')
  handleProjectSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { projectId: string },
  ) {
    client.join(`project:${data.projectId}`);
    return { success: true };
  }

  @SubscribeMessage('project_unsubscribe')
  handleProjectUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { projectId: string },
  ) {
    client.leave(`project:${data.projectId}`);
    return { success: true };
  }

  // ==================== TOOL STATUS EVENTS ====================

  // Tool status update from device
  @SubscribeMessage('tool_status_update')
  async handleToolStatusUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: { toolType: string; status: 'active' | 'inactive' | 'error' },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Update tool status in DB
    await this.devicesService.updateToolStatus(
      client.deviceId,
      data.toolType,
      data.status,
    );

    // Broadcast to device subscribers
    this.server.to(`device:${client.deviceId}`).emit('tool_status_update', {
      deviceId: client.deviceId,
      toolType: data.toolType,
      status: data.status,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  // ==================== CLAUDE SESSION EVENTS ====================

  // Claude session update from device
  @SubscribeMessage('claude_session_update')
  handleClaudeSessionUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      sessionKey: string;
      deviceId?: string; // Accept deviceId from body as fallback
      directory: string;
      state: 'active' | 'inactive' | 'suspended';
      lastUsedAt?: string;
      transcriptPath?: string;
    },
  ) {
    // Use deviceId from body as fallback (handles race condition where
    // handleConnection hasn't finished setting client.deviceId yet)
    const deviceId = client.deviceId || data.deviceId;
    this.logger.log(`Received claude_session_update: ${data.sessionKey}, deviceId: ${deviceId}, transcriptPath: ${data.transcriptPath}`);

    if (!deviceId) {
      this.logger.warn(`claude_session_update rejected: no deviceId on socket or in data`);
      return { error: 'Not authenticated as device' };
    }

    // Set client.deviceId if it was missing but provided in data
    if (!client.deviceId && data.deviceId) {
      client.deviceId = data.deviceId;
      client.isDevice = true;
    }

    // Prepare session data for broadcast
    const sessionData = {
      sessionKey: data.sessionKey,
      directory: data.directory,
      state: data.state,
      lastUsedAt: data.lastUsedAt || new Date().toISOString(),
      transcriptPath: data.transcriptPath,
      deviceId: deviceId,
    };

    // Buffer the DB write — flushed in batch on next cycle
    this.claudeSessionsService.bufferSessionUpsert(deviceId, data);

    // Broadcast to device subscribers immediately (mobile subscribes via subscribeToDevice)
    this.server.to(`device:${deviceId}`).emit('claude_session_update', sessionData);

    return { success: true };
  }

  // Mobile requests current Claude sessions from device
  @SubscribeMessage('claude_sessions_request')
  handleClaudeSessionsRequest(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Forward to device - CLI will send back current sessions
    this.sendToDevice(data.deviceId, 'claude_sessions_request', {
      requestedBy: client.userId,
    });

    return { success: true };
  }

  // Batch session update from CLI (replaces N individual events with 1)
  @SubscribeMessage('claude_session_batch_update')
  handleClaudeSessionBatchUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      sessions: Array<{
        sessionKey: string;
        deviceId?: string;
        directory: string;
        state: 'active' | 'inactive' | 'suspended';
        lastUsedAt?: string;
        transcriptPath?: string;
      }>;
    },
  ) {
    const deviceId = client.deviceId || data.sessions?.[0]?.deviceId;
    if (!deviceId) {
      return { error: 'Not authenticated as device' };
    }

    if (!client.deviceId && data.sessions?.[0]?.deviceId) {
      client.deviceId = data.sessions[0].deviceId;
      client.isDevice = true;
    }

    this.logger.log(`Received claude_session_batch_update: ${data.sessions?.length ?? 0} sessions`);

    // Collect sessions that need name backfill
    const needsNameBackfill: Array<{ sessionKey: string; transcriptPath: string }> = [];

    for (const session of data.sessions ?? []) {
      // Buffer for batched DB write
      this.claudeSessionsService.bufferSessionUpsert(deviceId, session);

      // Broadcast each individually — mobile expects individual events
      this.server.to(`device:${deviceId}`).emit('claude_session_update', {
        sessionKey: session.sessionKey,
        directory: session.directory,
        state: session.state,
        lastUsedAt: session.lastUsedAt || new Date().toISOString(),
        transcriptPath: session.transcriptPath,
        deviceId,
      });

      // Check if this session needs a name backfill
      if (session.transcriptPath) {
        const backfillKey = `${deviceId}:${session.sessionKey}`;
        if (!this.nameBackfillRequested.has(backfillKey)) {
          needsNameBackfill.push({
            sessionKey: session.sessionKey,
            transcriptPath: session.transcriptPath,
          });
        }
      }
    }

    // Request transcript for unnamed sessions so we can extract names
    if (needsNameBackfill.length > 0) {
      this.backfillSessionNames(deviceId, needsNameBackfill);
    }

    return { success: true, count: data.sessions?.length ?? 0 };
  }

  /**
   * For sessions without a name, request a small transcript fetch from the CLI
   * to extract the first user message. Runs in the background, non-blocking.
   */
  private async backfillSessionNames(
    deviceId: string,
    sessions: Array<{ sessionKey: string; transcriptPath: string }>,
  ): Promise<void> {
    // Check DB for which sessions actually need names
    const unnamed = await this.claudeSessionsService.getUnnamedSessions(deviceId);
    const unnamedKeys = new Set(unnamed.map((s) => s.sessionKey));

    let requested = 0;
    for (const session of sessions) {
      if (!unnamedKeys.has(session.sessionKey)) continue;

      const backfillKey = `${deviceId}:${session.sessionKey}`;
      this.nameBackfillRequested.add(backfillKey);

      // Request just the first 5 entries (enough to find the first user message)
      this.sendToDevice(deviceId, 'transcript_fetch', {
        sessionKey: session.sessionKey,
        transcriptPath: session.transcriptPath,
        offset: 0,
        limit: 5,
        reverse: false,
        requestedBy: '__system_backfill__',
      });

      requested++;
      // Stagger requests to avoid overwhelming the CLI
      if (requested % 10 === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (requested > 0) {
      this.logger.log(`Requested name backfill for ${requested} unnamed sessions on device ${deviceId}`);
    }
  }

  // ==================== DIRECTORY LISTING EVENTS ====================

  // Directory listing request from mobile
  @SubscribeMessage('directory_list')
  handleDirectoryList(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: { deviceId: string; path: string; requestId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Forward to device
    this.sendToDevice(data.deviceId, 'directory_list', {
      path: data.path,
      requestId: data.requestId,
      requestedBy: client.userId,
    });

    return { success: true };
  }

  // Directory listing response from device
  @SubscribeMessage('directory_list_response')
  handleDirectoryListResponse(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      requestId: string;
      entries: Array<{ name: string; type: 'file' | 'directory'; path: string }>;
      currentPath: string;
    },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Broadcast to device room (mobile app may be subscribed)
    this.server.to(`device:${client.deviceId}`).emit('directory_list_response', data);

    // Also broadcast to user room as fallback
    if (client.userId) {
      this.server.to(`user:${client.userId}`).emit('directory_list_response', data);
    }

    return { success: true };
  }

  // ==================== READ FILE EVENTS ====================

  // Read file request from mobile (e.g., CLAUDE.md)
  @SubscribeMessage('read_file')
  handleReadFile(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: { deviceId: string; filePath: string; requestId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Forward to device
    this.sendToDevice(data.deviceId, 'read_file', {
      filePath: data.filePath,
      requestId: data.requestId,
      requestedBy: client.userId,
    });

    return { success: true };
  }

  // Read file response from device
  @SubscribeMessage('read_file_response')
  handleReadFileResponse(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      requestId: string;
      content?: string;
      exists: boolean;
      fileName: string;
      error?: string;
    },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Broadcast to device room (mobile app may be subscribed)
    this.server.to(`device:${client.deviceId}`).emit('read_file_response', data);

    // Also broadcast to user room as fallback (mobile is always in user room)
    if (client.userId) {
      this.server.to(`user:${client.userId}`).emit('read_file_response', data);
    }

    return { success: true };
  }

  // ==================== TAB COMPLETION EVENTS ====================

  // Tab completion request from mobile
  @SubscribeMessage('tab_complete')
  handleTabComplete(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      terminalSessionId: string;
      partial: string;
      requestId: string;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.sendToDevice(data.deviceId, 'tab_complete', {
      terminalSessionId: data.terminalSessionId,
      partial: data.partial,
      requestId: data.requestId,
    });

    return { success: true };
  }

  // Tab completion response from device
  @SubscribeMessage('tab_complete_response')
  handleTabCompleteResponse(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: { requestId: string; completions: string[]; commonPrefix?: string },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    this.server.to(`device:${client.deviceId}`).emit('tab_complete_response', data);

    return { success: true };
  }

  // ==================== CLAUDE RESUME SESSION ====================

  // Resume Claude session request from mobile
  @SubscribeMessage('claude_resume_session')
  handleClaudeResumeSession(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      sessionKey: string;
      directory: string;
      terminalSessionId: string;
      dangerouslySkipPermissions?: boolean;
      interactivePermissions?: boolean;
    },
  ) {
    this.logger.log(`Received claude_resume_session from ${client.userId} for device ${data.deviceId}`);
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Forward to device - CLI will run `claude --resume`
    this.logger.log(`Forwarding claude_resume_session to device ${data.deviceId}, sessionKey: ${data.sessionKey}`);
    this.sendToDevice(data.deviceId, 'claude_resume_session', {
      sessionKey: data.sessionKey,
      directory: data.directory,
      terminalSessionId: data.terminalSessionId,
      requestedBy: client.userId,
      dangerouslySkipPermissions: data.dangerouslySkipPermissions ?? false,
      interactivePermissions: data.interactivePermissions ?? false,
    });

    return { success: true };
  }

  // Start new Claude session request from mobile
  @SubscribeMessage('claude_start_session')
  handleClaudeStartSession(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      directory: string;
      terminalSessionId: string;
      dangerouslySkipPermissions?: boolean;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Forward to device - CLI will run `claude` in the directory
    this.sendToDevice(data.deviceId, 'claude_start_session', {
      directory: data.directory,
      terminalSessionId: data.terminalSessionId,
      requestedBy: client.userId,
      dangerouslySkipPermissions: data.dangerouslySkipPermissions ?? false,
    });

    return { success: true };
  }

  // ==================== TRANSCRIPT EVENTS ====================

  // Mobile requests transcript history
  @SubscribeMessage('transcript_fetch')
  handleTranscriptFetch(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      sessionKey: string;
      transcriptPath: string;
      offset?: number;
      limit?: number;
      reverse?: boolean;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.sendToDevice(data.deviceId, 'transcript_fetch', {
      sessionKey: data.sessionKey,
      transcriptPath: data.transcriptPath,
      offset: data.offset || 0,
      limit: data.limit || 100,
      reverse: data.reverse !== false, // Default to true (most recent first)
      requestedBy: client.userId,
    });

    return { success: true };
  }

  // Mobile subscribes to transcript updates
  @SubscribeMessage('transcript_subscribe')
  handleTranscriptSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      sessionKey: string;
      transcriptPath: string;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.logger.log(`Mobile joining room: ${roomName}, userId: ${client.userId}`);

    // Join transcript room
    client.join(roomName);

    // Forward to device
    this.sendToDevice(data.deviceId, 'transcript_subscribe', {
      sessionKey: data.sessionKey,
      transcriptPath: data.transcriptPath,
      requestedBy: client.userId,
    });

    return { success: true };
  }

  // Mobile unsubscribes from transcript updates
  @SubscribeMessage('transcript_unsubscribe')
  handleTranscriptUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      sessionKey: string;
    },
  ) {
    client.leave(`transcript:${data.sessionKey}`);

    this.sendToDevice(data.deviceId, 'transcript_unsubscribe', {
      sessionKey: data.sessionKey,
    });

    return { success: true };
  }

  // Mobile subscribes to SDK streaming session (no transcript file watching)
  // This just joins the room to receive claude_message events from CLI
  @SubscribeMessage('transcript_subscribe_sdk')
  handleTranscriptSubscribeSdk(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      sessionKey: string;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.logger.log(`Mobile joining SDK streaming room: ${roomName}, userId: ${client.userId}`);

    // Join transcript room - CLI sends claude_message events here
    client.join(roomName);

    // Also tell CLI to start watching this session's transcript for live updates
    // Find a connected CLI for this user
    const userSessions = this.userCliConnections.get(client.userId);
    if (userSessions && userSessions.size > 0) {
      const cliSessionId = userSessions.values().next().value;
      this.logger.log(`Forwarding transcript_subscribe_sdk_start to CLI session: ${cliSessionId}`);
      this.sendToSession(cliSessionId, 'transcript_subscribe_sdk_start', {
        sessionKey: data.sessionKey,
        requestedBy: client.userId,
      });
    } else {
      this.logger.warn(`No CLI connected for user ${client.userId} to start transcript watching`);
    }

    return { success: true };
  }

  // Mobile unsubscribes from SDK streaming session
  @SubscribeMessage('transcript_unsubscribe_sdk')
  handleTranscriptUnsubscribeSdk(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      sessionKey: string;
    },
  ) {
    const roomName = `transcript:${data.sessionKey}`;
    this.logger.log(`Mobile leaving SDK streaming room: ${roomName}`);
    client.leave(roomName);
    return { success: true };
  }

  // Mobile requests SDK session message history
  // Forwards to CLI via RPC to read from Claude's JSONL transcript files
  @SubscribeMessage('sdk_session_history')
  async handleSdkSessionHistory(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      deviceId: string;
      sessionKey: string;
      claudeSessionId?: string; // Can be passed directly from mobile
      directory?: string; // Used by CLI to filter fallback sessions
      limit?: number;
      offset?: number;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.logger.log(`Mobile requesting SDK session history: ${data.sessionKey}`);
    this.logger.debug(`sdk_session_history called for sessionKey=${data.sessionKey}, deviceId=${data.deviceId}, claudeSessionId=${data.claudeSessionId}`);

    // Use claudeSessionId from request if provided, otherwise try DB lookup
    let claudeSessionId = data.claudeSessionId || null;
    if (!claudeSessionId) {
      const session = await this.claudeSessionsService.getSessionByKey(
        data.deviceId,
        data.sessionKey,
      );
      claudeSessionId = session?.claudeSessionId || null;
      this.logger.debug(`claudeSessionId from DB: ${claudeSessionId}`);
    } else {
      this.logger.debug(`Using claudeSessionId from request: ${claudeSessionId}`);
    }

    // Find ANY connected CLI for this user (not just the exact session or device)
    // This allows viewing history for old sessions as long as ANY CLI for this user is connected
    let cliSocket: Socket | undefined;
    let connectedSessionKey: string | undefined;

    // First try the exact session
    if (this.isSessionConnected(data.sessionKey)) {
      cliSocket = this.getSessionSocket(data.sessionKey);
      connectedSessionKey = data.sessionKey;
      this.logger.debug(`Found exact session ${data.sessionKey}`);
    }

    // If not found, try by userId (the Happy-coder pattern)
    if (!cliSocket && client.userId) {
      const userSessions = this.userCliConnections.get(client.userId);
      this.logger.debug(`Looking for CLI by userId ${client.userId}, userSessions: ${userSessions ? Array.from(userSessions) : 'none'}`);
      if (userSessions) {
        for (const sessionId of userSessions) {
          const socket = this.sessionSockets.get(sessionId) as AuthenticatedSocket | undefined;
          if (socket?.connected) {
            cliSocket = socket;
            connectedSessionKey = sessionId;
            this.logger.debug(`Using user's CLI session ${sessionId} for userId ${client.userId}`);
            break;
          }
        }
      }
    }

    // Fallback: try by deviceId (legacy approach)
    if (!cliSocket) {
      for (const [sessionId, socketId] of this.sessionConnections.entries()) {
        const socket = this.sessionSockets.get(sessionId) as AuthenticatedSocket | undefined;
        this.logger.debug(`Fallback - Checking session ${sessionId}: connected=${socket?.connected}, socketDeviceId=${socket?.deviceId}, requestedDeviceId=${data.deviceId}`);
        if (socket?.connected && socket.deviceId === data.deviceId) {
          cliSocket = socket;
          connectedSessionKey = sessionId;
          this.logger.debug(`Using alternate CLI session ${sessionId} for device ${data.deviceId}`);
          break;
        }
      }
    }

    this.logger.debug(`sessionConnections keys: ${JSON.stringify(Array.from(this.sessionConnections.keys()))}`);
    this.logger.debug(`userCliConnections keys: ${JSON.stringify(Array.from(this.userCliConnections.keys()))}`);
    this.logger.debug(`Found CLI socket: ${cliSocket ? 'yes' : 'no'}, via session: ${connectedSessionKey}`);

    // Forward to CLI via RPC
    const requestId = `history-${Date.now()}`;

    if (!cliSocket) {
      this.logger.debug(`No CLI socket found for session ${data.sessionKey}`);
      client.emit('sdk_session_history', {
        sessionKey: data.sessionKey,
        entries: [],
        totalEntries: 0,
        hasMore: false,
      });
      return { success: true };
    }

    // Set up timeout for response
    const timeout = setTimeout(() => {
      this.logger.warn(`RPC timeout for get_session_history: ${requestId}`);
      client.emit('sdk_session_history', {
        sessionKey: data.sessionKey,
        entries: [],
        totalEntries: 0,
        hasMore: false,
      });
    }, 5000);

    // Listen for RPC response from CLI
    interface RpcHistoryResponse {
      requestId: string;
      result?: {
        entries?: unknown[];
        totalEntries?: number;
        hasMore?: boolean;
      };
    }
    const responseHandler = (response: RpcHistoryResponse) => {
      if (response.requestId === requestId) {
        clearTimeout(timeout);
        cliSocket.off('rpc_response', responseHandler);

        client.emit('sdk_session_history', {
          sessionKey: data.sessionKey,
          entries: response.result?.entries || [],
          totalEntries: response.result?.totalEntries || 0,
          hasMore: response.result?.hasMore || false,
        });
      }
    };

    cliSocket.on('rpc_response', responseHandler);

    // Send RPC request to CLI
    this.logger.debug(`Sending RPC get_session_history to CLI, requestId=${requestId}, claudeSessionId=${claudeSessionId}, sessionKey=${data.sessionKey}`);
    this.sendToSession(connectedSessionKey!, 'rpc_request', {
      requestId,
      method: 'get_session_history',
      params: {
        claudeSessionId,
        sessionKey: data.sessionKey, // Pass original sessionKey so CLI can look it up
        directory: data.directory, // Used by CLI to filter fallback sessions by project
        limit: data.limit ?? 400,
        offset: data.offset ?? 0,
      },
    });

    return { success: true };
  }

  // Device sends transcript history
  @SubscribeMessage('transcript_history')
  handleTranscriptHistory(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: TranscriptHistoryPayload & { requestedBy?: string },
  ): { success: true } | { error: string } {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Send directly to the requesting user (works even if not in transcript room yet)
    // This avoids the race condition where the mobile hasn't joined the transcript
    // room yet, or has left it before the CLI response arrives.
    if (data.requestedBy && data.requestedBy !== '__system_backfill__') {
      this.sendToUser(data.requestedBy, 'transcript_history', data);
    } else {
      // Fallback: broadcast to room subscribers (for backfill or unknown requester)
      this.server.to(`transcript:${data.sessionKey}`).emit('transcript_history', data);
    }

    // Auto-set session name from the first user message in history
    if (client.deviceId && data.entries?.length > 0) {
      const firstUserEntry = data.entries.find(
        (e) => e.type === 'user' && e.content?.text,
      );
      if (firstUserEntry) {
        this.claudeSessionsService.trySetSessionName(
          client.deviceId,
          data.sessionKey,
          firstUserEntry.content!.text!,
        );
      }
    }

    return { success: true };
  }

  // Device sends transcript update (new entry)
  @SubscribeMessage('transcript_update')
  handleTranscriptUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: TranscriptUpdatePayload,
  ): { success: true } | { error: string } {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.logger.log(
      `Broadcasting transcript_update to room: ${roomName}, type: ${data.entry?.type}`,
    );

    // Broadcast to all subscribers of this transcript
    this.server.to(roomName).emit('transcript_update', data);

    // Auto-set session name from first user message in transcript mode
    if (
      data.entry?.type === 'user' &&
      data.entry.content?.text &&
      client.deviceId
    ) {
      this.claudeSessionsService.trySetSessionName(
        client.deviceId,
        data.sessionKey,
        data.entry.content.text,
      );
    }

    return { success: true };
  }

  // ==================== CLAUDE SDK STREAMING EVENTS ====================

  // Device sends Claude message (from SDK streaming)
  @SubscribeMessage('claude_message')
  handleClaudeMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ClaudeMessagePayload,
  ): { success: true } | { error: string } {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.logger.log(
      `Broadcasting claude_message to room: ${roomName}, type: ${data.message?.type}`,
    );

    // Broadcast to mobile clients
    this.server.to(roomName).emit('claude_message', data);

    // Buffer message for batched DB write (only for non-partial, completed messages)
    if (data.message && !data.message.partial && data.message.id) {
      this.claudeSessionsService.bufferMessageStore(
        data.deviceId,
        data.sessionKey,
        {
          messageId: data.message.id,
          type: data.message.type,
          content: data.message.content,
          toolName: data.message.toolName,
          toolInput: data.message.toolInput,
          isError: data.message.isError,
        },
      );
    }

    return { success: true };
  }

  // Device sends thinking state
  @SubscribeMessage('thinking_state')
  handleThinkingState(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      deviceId: string;
      sessionKey: string;
      thinking: boolean;
    },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.server.to(roomName).emit('thinking_state', data);
    return { success: true };
  }

  // Device sends thinking content (extended thinking text)
  @SubscribeMessage('thinking_content')
  handleThinkingContent(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      sessionKey?: string;
      thinkingId: string;
      content: string;
      partial: boolean;
    },
  ) {
    if (!client.deviceId && !client.sessionId) {
      return { error: 'Not authenticated as device/session' };
    }

    // Broadcast to session room
    if (data.sessionKey) {
      const roomName = `transcript:${data.sessionKey}`;
      this.server.to(roomName).emit('thinking_content', data);
    }

    // Also broadcast to user's channel
    if (client.userId) {
      this.server.to(`user:${client.userId}`).emit('thinking_content', data);
    }

    return { success: true };
  }

  // Device sends token usage
  @SubscribeMessage('token_usage')
  async handleTokenUsage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      sessionKey?: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
      };
    },
  ): Promise<{ success: true } | { error: string }> {
    if (!client.deviceId && !client.sessionId) {
      return { error: 'Not authenticated as device/session' };
    }

    // Broadcast to session room
    if (data.sessionKey) {
      const roomName = `transcript:${data.sessionKey}`;
      this.server.to(roomName).emit('token_usage', data);
    }

    // Also broadcast to user's channel
    if (client.userId) {
      this.server.to(`user:${client.userId}`).emit('token_usage', data);

      // Record token usage in analytics
      try {
        await this.analyticsService.recordTokenUsage(client.userId, {
          sessionId: data.sessionKey,
          inputTokens: data.usage.inputTokens,
          outputTokens: data.usage.outputTokens,
        });

        // Check for achievement unlocks
        const unlockedAchievements = await this.achievementCheckerService.checkTokenAchievements(client.userId);

        // Emit achievement_unlocked events for any new achievements
        for (const unlocked of unlockedAchievements) {
          this.server.to(`user:${client.userId}`).emit('achievement_unlocked', {
            achievement: {
              ...unlocked.achievement,
              threshold: unlocked.achievement.threshold.toString(),
            },
            unlockedAt: unlocked.userAchievement.unlockedAt,
          });
          this.logger.log(`Achievement unlocked: ${unlocked.achievement.key} for user ${client.userId}`);
        }
      } catch (error) {
        this.logger.error(`Failed to record token usage: ${error}`);
      }
    }

    return { success: true };
  }

  // Device sends task progress
  @SubscribeMessage('task_progress')
  handleTaskProgress(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      sessionKey?: string;
      type: 'created' | 'updated' | 'completed' | 'list';
      task?: {
        id: string;
        subject: string;
        status: 'pending' | 'in_progress' | 'completed';
        activeForm?: string;
      };
      tasks?: Array<{
        id: string;
        subject: string;
        status: 'pending' | 'in_progress' | 'completed';
        activeForm?: string;
      }>;
    },
  ) {
    if (!client.deviceId && !client.sessionId) {
      return { error: 'Not authenticated as device/session' };
    }

    // Broadcast to session room
    if (data.sessionKey) {
      const roomName = `transcript:${data.sessionKey}`;
      this.server.to(roomName).emit('task_progress', data);
    }

    // Also broadcast to user's channel
    if (client.userId) {
      this.server.to(`user:${client.userId}`).emit('task_progress', data);
    }

    return { success: true };
  }

  // ==================== RPC FORWARDING ====================

  // Mobile app calls RPC method on CLI session
  @SubscribeMessage('rpc_call')
  async handleRpcCall(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      method: string;
      params: Record<string, unknown>;
      targetSessionId?: string;
      targetDeviceId?: string;
      timeout?: number;
    },
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!client.userId) {
      return { ok: false, error: 'Not authenticated' };
    }

    const { method, params, targetSessionId, targetDeviceId, timeout = 30000 } = data;

    // Determine target socket
    let targetSocket: Socket | undefined;

    if (targetSessionId && this.isSessionConnected(targetSessionId)) {
      targetSocket = this.getSessionSocket(targetSessionId);
      this.logger.log(`RPC call to session ${targetSessionId}: ${method}`);
    } else if (targetDeviceId) {
      const socketId = this.deviceConnections.get(targetDeviceId);
      if (socketId) {
        targetSocket = this.server.sockets.sockets.get(socketId);
      }
      this.logger.log(`RPC call to device ${targetDeviceId}: ${method}`);
    }

    if (!targetSocket) {
      return { ok: false, error: 'Target not connected' };
    }

    try {
      // Forward RPC request to CLI and wait for response
      const response = await targetSocket
        .timeout(timeout)
        .emitWithAck('rpc_request', { method, params, requestId: `rpc-${Date.now()}` });

      return { ok: true, result: response };
    } catch (error) {
      this.logger.error(`RPC call failed: ${error}`);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'RPC call failed',
      };
    }
  }

  // Forward RPC response from CLI to mobile
  @SubscribeMessage('rpc_response')
  handleRpcResponse(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      requestId: string;
      result?: unknown;
      error?: { code: number; message: string };
    },
  ): { success: true } {
    // RPC responses are typically handled via acknowledgement callbacks
    // This handler is for backward compatibility with the event-based approach
    this.logger.log(`RPC response received: ${data.requestId}`);

    // Broadcast to any listeners
    if (client.deviceId) {
      this.server.to(`device:${client.deviceId}`).emit('rpc_response', data);
    }
    if (client.sessionId) {
      this.server.to(`transcript:${client.sessionId}`).emit('rpc_response', data);
    }

    return { success: true };
  }

  // Session keep-alive from CLI
  @SubscribeMessage('session-alive')
  handleSessionAlive(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      sessionId: string;
      deviceId?: string;
      time: number;
      thinking: boolean;
      mode: 'local' | 'remote';
    },
  ) {
    // Update session status if needed
    if (data.sessionId && client.sessionId === data.sessionId) {
      // Emit to subscribers watching this session
      const roomName = `transcript:${data.sessionId}`;
      this.server.to(roomName).emit('session_alive', {
        sessionId: data.sessionId,
        thinking: data.thinking,
        mode: data.mode,
        timestamp: data.time,
      });
    }

    return { success: true };
  }

  // Session event from CLI (ready, switch mode, etc.)
  @SubscribeMessage('claude_session_event')
  handleClaudeSessionEvent(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      deviceId: string;
      sessionKey: string;
      event: {
        type: 'switch' | 'message' | 'permission-mode-changed' | 'ready';
        mode?: string;
        message?: string;
      };
    },
  ) {
    if (!client.deviceId && !client.sessionId) {
      return { error: 'Not authenticated as device/session' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.server.to(roomName).emit('claude_session_event', data);

    this.logger.log(`Session event: ${data.event.type} for ${data.sessionKey}`);
    return { success: true };
  }

  // Permission request from CLI
  @SubscribeMessage('permission_request')
  handlePermissionRequest(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      deviceId: string;
      sessionKey: string;
      requestId: string;
      type: 'tool_use' | 'file_write' | 'bash_command';
      toolName?: string;
      description: string;
      details?: Record<string, unknown>;
    },
  ): { success: true } | { error: string } {
    if (!client.deviceId && !client.sessionId) {
      return { error: 'Not authenticated as device/session' };
    }

    // Send to users watching this session
    const roomName = `transcript:${data.sessionKey}`;
    this.server.to(roomName).emit('permission_request', data);

    this.logger.log(
      `Permission request: ${data.type} ${data.toolName || ''} for ${data.sessionKey}`,
    );
    return { success: true };
  }

  // ==================== CLAUDE APPROVAL EVENTS ====================

  // CLI sends Claude approval request (e.g., [y]es, [n]o, [p]lan prompt)
  @SubscribeMessage('claude_approval_request')
  async handleClaudeApprovalRequest(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      approvalId: string;
      terminalSessionId: string;
      sessionKey?: string;
      context: string[];      // Recent output lines for context
      options: string[];      // Available options (e.g., ['y:yes', 'n:no', 'p:plan'])
      promptText: string;     // The actual prompt text
    },
  ) {
    if (!client.deviceId && !client.sessionId) {
      return { error: 'Not authenticated as device/session' };
    }

    const userId = client.userId;
    if (!userId) {
      this.logger.warn(`Claude approval request from device without userId`);
      return { error: 'No userId associated with device' };
    }

    this.logger.log(
      `Claude approval request: ${data.approvalId} from ${client.deviceId || client.sessionId}, userId: ${userId}`,
    );

    // Track pending approval with timeout
    this.notificationsService.trackPendingApproval(
      data.approvalId,
      userId,
      {
        terminalSessionId: data.terminalSessionId,
        sessionKey: data.sessionKey,
        context: data.context,
        options: data.options,
        promptText: data.promptText,
      },
      (approvalId) => {
        // On timeout, send auto-deny to CLI
        this.logger.log(`Approval timeout for ${approvalId}, sending auto-deny`);
        const sessionId = data.sessionKey || client.sessionId;
        if (sessionId) {
          this.sendToSession(sessionId, 'claude_approval_response', {
            approvalId,
            response: 'n',
            respondedBy: 'system_timeout',
          });
        } else if (client.deviceId) {
          this.sendToDevice(client.deviceId, 'claude_approval_response', {
            approvalId,
            response: 'n',
            respondedBy: 'system_timeout',
          });
        }
      },
    );

    // Forward to user's mobile clients via WebSocket
    const roomName = data.sessionKey ? `transcript:${data.sessionKey}` : `user:${userId}`;
    // Only send to user's channel (mobile is user-scoped, so this is the primary route)
    // Avoid sending to multiple rooms to prevent duplicate messages
    this.logger.log(`Sending claude_approval_request ${data.approvalId} to user:${userId}`);

    this.server.to(`user:${userId}`).emit('claude_approval_request', {
      ...data,
      deviceId: client.deviceId,
      timestamp: new Date().toISOString(),
    });

    // Send push notification if user has registered tokens
    try {
      await this.notificationsService.sendApprovalNotification(userId, data.approvalId, {
        terminalSessionId: data.terminalSessionId,
        sessionKey: data.sessionKey,
        context: data.context,
        options: data.options,
        promptText: data.promptText,
      });
    } catch (error) {
      this.logger.error(`Failed to send push notification: ${error}`);
    }

    return { success: true };
  }

  // Permission prompt from CLI — Claude wants to use a tool and needs mobile approval
  @SubscribeMessage('permission_prompt')
  async handlePermissionPrompt(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      promptId: string;
      terminalSessionId: string;
      sessionKey?: string;
      toolName: string;
      toolInput: any;
      toolUseId: string;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.logger.log(
      `Permission prompt from CLI: ${data.toolName} (${data.promptId}) for user ${client.userId}`,
    );

    // Forward to user's mobile clients
    this.server.to(`user:${client.userId}`).emit('permission_prompt', {
      ...data,
      deviceId: client.deviceId,
      timestamp: new Date().toISOString(),
    });

    // Send push notification for permission prompt
    try {
      await this.notificationsService.sendApprovalNotification(client.userId, data.promptId, {
        terminalSessionId: data.terminalSessionId,
        sessionKey: data.sessionKey,
        context: [],
        options: ['y:yes', 'n:no'],
        promptText: `Claude wants to use ${data.toolName}`,
      });
    } catch (error) {
      this.logger.error(`Failed to send push notification for permission prompt: ${error}`);
    }

    return { success: true };
  }

  // Pending permissions sync from CLI — sends all pending prompts to mobile on take-over
  @SubscribeMessage('pending_permissions_sync')
  handlePendingPermissionsSync(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      sessionKey: string;
      terminalSessionId: string;
      prompts: any[];
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.logger.log(
      `Pending permissions sync from CLI: ${data.prompts?.length || 0} prompt(s) for user ${client.userId}`,
    );

    // Forward to user's mobile clients
    this.server.to(`user:${client.userId}`).emit('pending_permissions_sync', {
      ...data,
      deviceId: client.deviceId,
    });

    return { success: true };
  }

  // Permission rules sync from mobile — user's tool approval configuration
  @SubscribeMessage('permission_rules_sync')
  handlePermissionRulesSync(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      deviceId?: string;
      sessionKey: string;
      terminalSessionId: string;
      rules: any[];
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    const targetDeviceId = data.deviceId || client.deviceId;
    this.logger.log(
      `Permission rules sync: ${data.rules?.length || 0} rule(s) for device ${targetDeviceId}`,
    );

    // Forward to the target device's CLI
    this.server.to(`device:${targetDeviceId}`).emit('permission_rules_sync', {
      ...data,
      deviceId: targetDeviceId,
    });

    return { success: true };
  }

  // Permission response from mobile — user approved or denied a tool use
  @SubscribeMessage('permission_response')
  handlePermissionResponse(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      promptId: string;
      decision: 'allow' | 'deny';
      reason?: string;
      deviceId?: string;
      sessionKey?: string;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.logger.log(
      `Permission response: ${data.promptId} -> ${data.decision} from ${client.userId}`,
    );

    const responsePayload = {
      promptId: data.promptId,
      decision: data.decision,
      reason: data.reason,
      respondedBy: client.userId,
    };

    // Route response back to CLI — try session, then device, then user's CLIs
    let routingSucceeded = false;

    if (data.sessionKey && this.isSessionConnected(data.sessionKey)) {
      this.sendToSession(data.sessionKey, 'permission_response', responsePayload);
      routingSucceeded = true;
    }

    if (!routingSucceeded && data.deviceId && this.isDeviceOnline(data.deviceId)) {
      this.sendToDevice(data.deviceId, 'permission_response', responsePayload);
      routingSucceeded = true;
    }

    if (!routingSucceeded) {
      // Fallback: find any CLI for this user
      const userSessions = this.userCliConnections.get(client.userId);
      if (userSessions && userSessions.size > 0) {
        const cliSessionId = userSessions.values().next().value;
        if (this.isSessionConnected(cliSessionId)) {
          this.sendToSession(cliSessionId, 'permission_response', responsePayload);
          routingSucceeded = true;
        }
      }
    }

    if (!routingSucceeded) {
      this.logger.error(
        `Failed to route permission response for ${data.promptId}: No connected CLI found`,
      );
      return { error: 'No CLI connection found' };
    }

    return { success: true };
  }

  // Tool activity notification from CLI (non-blocking, informational only)
  @SubscribeMessage('tool_activity')
  handleToolActivity(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      terminalSessionId: string;
      sessionKey?: string;
      toolName: string;
      toolId: string;
      inputSummary: string;
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    // Forward to user's mobile clients
    this.server.to(`user:${client.userId}`).emit('tool_activity', {
      ...data,
      deviceId: client.deviceId,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  // Mobile app responds to Claude approval request
  @SubscribeMessage('claude_approval_response')
  handleClaudeApprovalResponse(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      approvalId: string;
      response: string;       // The response character ('y', 'n', 'p', etc.)
      deviceId?: string;      // Optional: target device ID
      sessionKey?: string;    // Optional: target session key
    },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.logger.log(
      `Claude approval response: ${data.approvalId} -> ${data.response} from ${client.userId}`,
    );

    // Complete the pending approval
    const pending = this.notificationsService.completePendingApproval(data.approvalId);
    if (!pending) {
      this.logger.warn(`No pending approval found for ${data.approvalId}`);
      return { error: 'Approval not found or already processed' };
    }

    // Route response back to CLI
    // Prefer session-scoped routing, then device routing
    const responsePayload = {
      approvalId: data.approvalId,
      response: data.response,
      respondedBy: client.userId,
    };

    // Try session key from request, then from pending approval
    const sessionKey = data.sessionKey || pending.sessionKey;
    let routingSucceeded = false;

    if (sessionKey && this.isSessionConnected(sessionKey)) {
      this.sendToSession(sessionKey, 'claude_approval_response', responsePayload);
      this.logger.log(`Sent approval response to session ${sessionKey}`);
      routingSucceeded = true;
    } else if (sessionKey) {
      // Session key provided but not connected
      this.logger.warn(`Session ${sessionKey} is not connected, trying fallback routing for approval ${data.approvalId}`);
    }

    if (!routingSucceeded && data.deviceId && this.isDeviceOnline(data.deviceId)) {
      this.sendToDevice(data.deviceId, 'claude_approval_response', responsePayload);
      this.logger.log(`Sent approval response to device ${data.deviceId}`);
      routingSucceeded = true;
    } else if (!routingSucceeded && data.deviceId) {
      // Device ID provided but not online
      this.logger.warn(`Device ${data.deviceId} is not online, trying fallback routing for approval ${data.approvalId}`);
    }

    if (!routingSucceeded) {
      // Try to find CLI by userId as fallback
      const userSessions = this.userCliConnections.get(pending.userId);
      if (userSessions && userSessions.size > 0) {
        const cliSessionId = userSessions.values().next().value;
        if (this.isSessionConnected(cliSessionId)) {
          this.sendToSession(cliSessionId, 'claude_approval_response', responsePayload);
          this.logger.log(`Sent approval response to user's CLI session ${cliSessionId}`);
          routingSucceeded = true;
        } else {
          this.logger.error(`User's CLI session ${cliSessionId} found but not connected for approval ${data.approvalId}`);
        }
      }
    }

    if (!routingSucceeded) {
      this.logger.error(`Failed to route approval response for ${data.approvalId}: No connected CLI found (sessionKey=${sessionKey}, deviceId=${data.deviceId}, userId=${pending.userId})`);
      return { error: 'No CLI connection found - the CLI may have disconnected' };
    }

    return { success: true };
  }

  // ==================== RATE LIMIT & QUEUE EVENTS ====================

  // CLI reports rate limit detected
  @SubscribeMessage('rate_limit_detected')
  async handleRateLimitDetected(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      deviceId: string;
      sessionKey?: string;
      prompt: string;
      rateLimitReason?: string;
      retryAfter?: string; // ISO date string
    },
  ): Promise<{ success: true; queueItemId?: string } | { error: string }> {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    this.logger.log(`Rate limit detected for user ${client.userId}: ${data.rateLimitReason}`);

    try {
      // Queue the prompt
      const queueItem = await this.promptQueueService.queuePrompt(client.userId, {
        deviceId: data.deviceId,
        sessionKey: data.sessionKey,
        prompt: data.prompt,
        rateLimitReason: data.rateLimitReason,
        retryAfter: data.retryAfter ? new Date(data.retryAfter) : undefined,
      });

      // Notify user's mobile app
      this.server.to(`user:${client.userId}`).emit('prompt_queued', {
        queueItemId: queueItem.id,
        deviceId: data.deviceId,
        sessionKey: data.sessionKey,
        prompt: data.prompt.substring(0, 100) + (data.prompt.length > 100 ? '...' : ''),
        rateLimitReason: data.rateLimitReason,
        retryAfter: data.retryAfter,
        createdAt: queueItem.createdAt.toISOString(),
      });

      return { success: true, queueItemId: queueItem.id };
    } catch (error) {
      this.logger.error(`Failed to queue prompt: ${error}`);
      return { error: 'Failed to queue prompt' };
    }
  }

  // Mobile triggers queue item execution
  @SubscribeMessage('execute_queue_item')
  async handleExecuteQueueItem(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      queueItemId: string;
    },
  ): Promise<{ success: true } | { error: string }> {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    try {
      const item = await this.promptQueueService.getQueueItem(client.userId, data.queueItemId);

      // Mark as executing
      await this.promptQueueService.markExecuting(item.id);

      // Emit to user's CLIs
      this.server.to(`user:${client.userId}`).emit('queue_item_executing', {
        queueItemId: item.id,
        deviceId: item.deviceId,
        sessionKey: item.sessionKey,
        prompt: item.prompt,
      });

      // Also try to send directly to the session if connected
      if (item.sessionKey && this.isSessionConnected(item.sessionKey)) {
        this.sendToSession(item.sessionKey, 'queue_item_executing', {
          queueItemId: item.id,
          prompt: item.prompt,
        });
      } else if (item.deviceId && this.isDeviceOnline(item.deviceId)) {
        this.sendToDevice(item.deviceId, 'queue_item_executing', {
          queueItemId: item.id,
          sessionKey: item.sessionKey,
          prompt: item.prompt,
        });
      }

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to execute queue item: ${error}`);
      const message = error instanceof Error ? error.message : 'Failed to execute queue item';
      return { error: message };
    }
  }

  // CLI reports queue item execution completed
  @SubscribeMessage('queue_item_completed')
  async handleQueueItemCompleted(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      queueItemId: string;
      success: boolean;
      errorMessage?: string;
    },
  ): Promise<{ success: true } | { error: string }> {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }

    try {
      if (data.success) {
        await this.promptQueueService.markCompleted(data.queueItemId);
      } else {
        await this.promptQueueService.markFailed(data.queueItemId, data.errorMessage);
      }

      // Notify user's mobile app
      this.server.to(`user:${client.userId}`).emit('queue_item_executed', {
        queueItemId: data.queueItemId,
        success: data.success,
        errorMessage: data.errorMessage,
        executedAt: new Date().toISOString(),
      });

      // Also emit queue update
      const pendingCount = await this.promptQueueService.getPendingCount(client.userId);
      this.server.to(`user:${client.userId}`).emit('queue_updated', {
        pendingCount,
      });

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to mark queue item completed: ${error}`);
      return { error: 'Failed to update queue item' };
    }
  }

  // ===== E2EE (End-to-End Encryption) Handlers =====

  /**
   * Handle encrypted key exchange initialization
   * Mobile → CLI: Initial key exchange
   */
  @SubscribeMessage('encrypted_key_exchange_init')
  async handleEncryptedKeyExchangeInit(
    @MessageBody() data: {
      senderDeviceId: string;
      recipientDeviceId: string;
      ephemeralPublicKey: string;
    },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    if (!data.recipientDeviceId) {
      client.emit('error', { message: 'recipientDeviceId is required' });
      return;
    }

    // Find recipient socket
    const recipientSocket = this.findSocketByDeviceId(data.recipientDeviceId);

    if (recipientSocket) {
      // Forward key exchange init to recipient
      recipientSocket.emit('encrypted_key_exchange_init', {
        senderDeviceId: data.senderDeviceId,
        ephemeralPublicKey: data.ephemeralPublicKey,
      });
    }
    // If recipient offline, silently ignore (could store for later delivery)
  }

  /**
   * Handle encrypted key exchange acknowledgment
   * CLI → Mobile: Key exchange response
   */
  @SubscribeMessage('encrypted_key_exchange_ack')
  async handleEncryptedKeyExchangeAck(
    @MessageBody() data: {
      senderDeviceId: string;
      recipientDeviceId: string;
      ephemeralPublicKey: string;
    },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    if (!data.recipientDeviceId) {
      client.emit('error', { message: 'recipientDeviceId is required' });
      return;
    }

    // Find recipient socket (original sender)
    const recipientSocket = this.findSocketByDeviceId(data.recipientDeviceId);

    if (recipientSocket) {
      recipientSocket.emit('encrypted_key_exchange_ack', {
        senderDeviceId: data.senderDeviceId,
        ephemeralPublicKey: data.ephemeralPublicKey,
      });
    }
  }

  /**
   * Handle encrypted message
   * Forward encrypted blob without decryption
   */
  @SubscribeMessage('encrypted_message')
  async handleEncryptedMessage(
    @MessageBody() data: {
      senderDeviceId: string;
      recipientDeviceId: string;
      sessionId: string;
      payload: {
        ciphertext: string;
        nonce: string;
        authTag: string;
      };
      messageCounter: number;
      timestamp: string;
    },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    if (!data.senderDeviceId || !data.recipientDeviceId) {
      client.emit('error', {
        message: 'senderDeviceId and recipientDeviceId are required',
      });
      return;
    }

    // Find recipient socket
    const recipientSocket = this.findSocketByDeviceId(data.recipientDeviceId);

    if (recipientSocket) {
      // Forward encrypted message as-is (no decryption)
      recipientSocket.emit('encrypted_message', data);
    }
    // If recipient offline, could store for later delivery
  }

  /**
   * Find a socket by device ID
   */
  private findSocketByDeviceId(deviceId: string): AuthenticatedSocket | null {
    const socketId = this.deviceConnections.get(deviceId);
    if (!socketId) {
      return null;
    }
    return this.server.sockets.sockets.get(socketId) as AuthenticatedSocket | null;
  }
}
