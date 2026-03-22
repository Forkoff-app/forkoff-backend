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
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DevicesService } from '../devices/devices.service';
import { ClaudeSessionsService } from '../claude-sessions/claude-sessions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AchievementCheckerService } from '../achievements/achievement-checker.service';
import { PromptQueueService } from '../prompt-queue/prompt-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceStatus } from '@prisma/client';
import { truncateId } from '../logging/sanitize';
import { createHash, randomBytes, randomUUID } from 'crypto';

/** Hash a raw device ID to a 32-hex-char (128-bit) opaque identifier for storage */
function hashDeviceId(rawId: string): string {
  return createHash('sha256').update(rawId).digest('hex').slice(0, 32);
}

interface AuthenticatedSocket extends Socket {
  userId?: string;
  deviceId?: string;
  isDevice?: boolean; // true if connection is from CLI tool, false if from mobile app
  clientType?: 'user-scoped' | 'session-scoped' | 'cli'; // Connection scoping type
  sessionId?: string; // Session ID for session-scoped connections
  cliVersion?: string; // CLI version from handshake auth
}

// Cloud relay pairing: in-memory store for pairing codes registered by CLI clients
interface PairingCodeEntry {
  cliSocketId: string;
  cliDeviceId: string;
  cliDeviceName: string;
  platform: string;
  createdAt: number;
}

// Cloud relay: paired device tokens for reconnect authentication
interface PairedDeviceEntry {
  mobileDeviceId: string;
  cliRelayToken: string;
  mobileRelayToken: string;
  pairId: string;
}

/** TTL for pairing codes (10 minutes) */
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

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
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  async afterInit() {
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

    // Clean up expired pairing codes every 60 seconds
    this.pairingCodeCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [code, entry] of this.pairingCodes) {
        if (now - entry.createdAt > PAIRING_CODE_TTL_MS) {
          this.pairingCodes.delete(code);
        }
      }
    }, 60_000);

    // Load persisted cloud pairings from DB into in-memory maps
    try {
      const pairings = await this.prisma.cloudPairing.findMany();
      for (const p of pairings) {
        this.pairedDevices.set(p.cliDeviceHash, {
          mobileDeviceId: p.mobileDeviceHash,
          cliRelayToken: p.cliRelayToken,
          mobileRelayToken: p.mobileRelayToken,
          pairId: p.pairId,
        });
        this.mobileToCli.set(p.mobileDeviceHash, p.cliDeviceHash);
      }
      this.logger.log(`Loaded ${pairings.length} cloud pairing(s) from DB`);
    } catch (error) {
      this.logger.error(`Failed to load cloud pairings from DB: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Mark all devices as OFFLINE on startup — no sockets exist yet,
    // so any ONLINE status in DB is stale from before the restart.
    // This prevents duplicate offline notifications when stale devices
    // are detected as "newly disconnected" during the first connection cycle.
    try {
      const { count } = await this.prisma.device.updateMany({
        where: { status: DeviceStatus.ONLINE },
        data: { status: DeviceStatus.OFFLINE },
      });
      if (count > 0) {
        this.logger.log(`Startup: marked ${count} stale device(s) as OFFLINE`);
      }
    } catch (error) {
      this.logger.error(`Failed to reset device statuses on startup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  @WebSocketServer()
  server: Server;

  /** Safe accessor — NestJS may inject Namespace (server.sockets IS the Map) or Server (server.sockets.sockets is the Map) */
  private get connectedSockets(): Map<string, AuthenticatedSocket> {
    return (this.server.sockets?.sockets ?? this.server.sockets) as Map<string, AuthenticatedSocket>;
  }

  private readonly logger = new Logger(WebsocketGateway.name);
  private supabase: SupabaseClient;

  // Track sessions we've already requested name backfill for (avoid repeats)
  private nameBackfillRequested = new Set<string>();

  // Track devices that have been notified as offline — only notify again after they come back ONLINE
  private offlineNotified = new Set<string>();

  // Track connected clients
  private userConnections = new Map<string, Set<string>>(); // userId -> Set of socket IDs
  private deviceConnections = new Map<string, string>(); // deviceId -> socket ID
  private sessionConnections = new Map<string, string>(); // sessionId -> socket ID (for session-scoped CLI connections)
  private sessionSockets = new Map<string, Socket>(); // sessionId -> Socket object (direct reference)
  private userCliConnections = new Map<string, Set<string>>(); // userId -> Set of sessionIds (track CLIs by user for cross-device routing)

  // Device ownership cache: deviceId -> { userId, cachedAt } (for authorization checks, 5min TTL)
  private static readonly OWNERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;
  private deviceOwnershipCache = new Map<string, { userId: string; cachedAt: number }>();

  // Grace period: delay marking devices OFFLINE to tolerate brief disconnects (e.g., network blips)
  private static readonly DISCONNECT_GRACE_PERIOD_MS = 5_000;
  private disconnectGraceTimers = new Map<string, NodeJS.Timeout>(); // deviceId -> timer

  // Cloud relay: in-memory pairing code store (code -> CLI info, TTL: 10min)
  private pairingCodes = new Map<string, PairingCodeEntry>();
  // Cloud relay: paired device tokens (cliDeviceId -> pairing tokens)
  private pairedDevices = new Map<string, PairedDeviceEntry>();
  // Cloud relay: CLI client connections (cliDeviceId -> socketId)
  private cliClientConnections = new Map<string, string>();
  // Cloud relay: CLI sockets (cliDeviceId -> Socket)
  private cliClientSockets = new Map<string, AuthenticatedSocket>();
  // Cloud relay: mobile-to-CLI device mapping (mobileDeviceId -> cliDeviceId)
  private mobileToCli = new Map<string, string>();
  // Cleanup interval for expired pairing codes
  private pairingCodeCleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private configService: ConfigService,
    private devicesService: DevicesService,
    private claudeSessionsService: ClaudeSessionsService,
    private notificationsService: NotificationsService,
    private analyticsService: AnalyticsService,
    private achievementCheckerService: AchievementCheckerService,
    private promptQueueService: PromptQueueService,
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

  /**
   * Verify that a user owns a device. Uses an in-memory cache to avoid
   * repeated DB lookups, falling back to Prisma when the cache misses.
   * Also accepts cloud-paired devices (not in legacy devices table).
   */
  private async verifyDeviceOwnership(
    userId: string,
    deviceId: string,
    client?: AuthenticatedSocket,
  ): Promise<boolean> {
    const cached = this.deviceOwnershipCache.get(deviceId);
    if (cached !== undefined) {
      // Invalidate stale cache entries (older than 5 minutes)
      if (Date.now() - cached.cachedAt > WebsocketGateway.OWNERSHIP_CACHE_TTL_MS) {
        this.deviceOwnershipCache.delete(deviceId);
      } else {
        return cached.userId === userId;
      }
    }

    // Check legacy devices table
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { userId: true },
    });
    if (device?.userId) {
      this.deviceOwnershipCache.set(deviceId, { userId: device.userId, cachedAt: Date.now() });
      return device.userId === userId;
    }

    // Cloud relay: verify the requesting mobile is actually paired to this CLI device.
    // mobileToCli maps hashed(mobileDeviceId) -> hashed(cliDeviceId).
    if (this.cliClientConnections.has(deviceId) && client) {
      const mobileDeviceId = client.handshake?.auth?.mobileDeviceId as string | undefined;
      if (mobileDeviceId) {
        const mobileHash = hashDeviceId(mobileDeviceId);
        const cliHash = hashDeviceId(deviceId);
        const pairedCliHash = this.mobileToCli.get(mobileHash);
        if (pairedCliHash === cliHash) {
          this.deviceOwnershipCache.set(deviceId, { userId, cachedAt: Date.now() });
          return true;
        }
      }
    }

    return false;
  }

  async handleConnection(client: AuthenticatedSocket) {
    this.logger.log(`handleConnection start`);

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
        this.offlineNotified.delete(deviceId);
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

          this.logger.log(`User ${truncateId(supabaseUser.id)} connected (socket: ${client.id})`);
        }
      }

      // Handle CLI cloud relay client connections (clientType: 'cli')
      const rawClientType = client.handshake.auth?.clientType as string | undefined;
      if (rawClientType === 'cli') {
        const cliDeviceId = client.handshake.auth?.deviceId as string;
        const relayToken = client.handshake.auth?.relayToken as string | undefined;

        if (!cliDeviceId) {
          this.logger.warn(`[WS] CLI client connected without deviceId — disconnecting`);
          client.disconnect(true);
          return;
        }

        client.clientType = 'cli';
        client.deviceId = cliDeviceId;
        client.isDevice = true;

        // If relay token provided, verify against stored pair (keyed by hashed ID)
        if (relayToken) {
          const cliHash = hashDeviceId(cliDeviceId);
          const pair = this.pairedDevices.get(cliHash);
          if (pair && pair.cliRelayToken === relayToken) {
            this.logger.log(`CLI ${truncateId(cliDeviceId)} authenticated via relay token`);
          } else if (pair && pair.cliRelayToken !== relayToken) {
            // Token mismatch — check if device is registered in DB (legitimate reconnect with rotated token)
            const dbDevice = await this.prisma.device.findUnique({
              where: { id: cliDeviceId },
              select: { userId: true },
            });
            if (dbDevice?.userId) {
              // Device exists in DB — auto-heal: update the stored relay token
              this.logger.log(`CLI ${truncateId(cliDeviceId)} relay token mismatch but device registered — updating stored token`);
              pair.cliRelayToken = relayToken;
              // Persist updated token to DB (non-blocking)
              this.prisma.cloudPairing.updateMany({
                where: { cliDeviceHash: cliHash },
                data: { cliRelayToken: relayToken },
              }).catch((err) =>
                this.logger.error(`Failed to update relay token in DB: ${err instanceof Error ? err.message : String(err)}`),
              );
            } else {
              // Unknown device with wrong token — reject
              this.logger.warn(`CLI ${truncateId(cliDeviceId)} relay token mismatch and device not in DB — rejecting`);
              client.disconnect(true);
              return;
            }
          } else {
            // No pair entry in memory — check DB for the device
            this.logger.log(`CLI ${truncateId(cliDeviceId)} no in-memory pair entry — allowing connection`);
          }
        }

        // Track CLI client connection
        this.cliClientConnections.set(cliDeviceId, client.id);
        this.cliClientSockets.set(cliDeviceId, client);
        this.deviceConnections.set(cliDeviceId, client.id);
        this.cancelGraceTimer(cliDeviceId);
        this.offlineNotified.delete(cliDeviceId);

        // Join device room so events addressed to this device reach the CLI
        client.join(`device:${cliDeviceId}`);

        // Try to update device status in DB (may not exist yet for first-time cloud pairing)
        try {
          const device = await this.devicesService.updateStatus(cliDeviceId, DeviceStatus.ONLINE);
          if (device.userId && device.userId !== 'pending') {
            this.deviceOwnershipCache.set(cliDeviceId, { userId: device.userId, cachedAt: Date.now() });
            client.userId = device.userId;
            if (!this.userConnections.has(device.userId)) {
              this.userConnections.set(device.userId, new Set());
            }
            this.userConnections.get(device.userId)!.add(client.id);
            client.join(`user:${device.userId}`);
            this.server.to(`user:${device.userId}`).emit('device_status', {
              deviceId: cliDeviceId,
              status: DeviceStatus.ONLINE,
            });
          }
        } catch {
          // Device may not exist yet (first-time cloud pairing) — that's OK
          this.logger.log(`CLI ${cliDeviceId} connected (device not yet in DB — awaiting pairing)`);
        }

        // Fallback: use userId from CLI auth handshake if DB lookup didn't set it
        if (!client.userId) {
          const cliAuthUserId = client.handshake.auth?.userId as string | undefined;
          if (cliAuthUserId) {
            client.userId = cliAuthUserId;
            this.deviceOwnershipCache.set(cliDeviceId, { userId: cliAuthUserId, cachedAt: Date.now() });
            if (!this.userConnections.has(cliAuthUserId)) {
              this.userConnections.set(cliAuthUserId, new Set());
            }
            this.userConnections.get(cliAuthUserId)!.add(client.id);
            client.join(`user:${cliAuthUserId}`);
            this.logger.log(`CLI ${truncateId(cliDeviceId)} userId set from auth handshake: ${truncateId(cliAuthUserId)}`);
          }
        }

        // Check if paired mobile is online and notify both sides (keyed by hashed ID)
        const cliHashForPair = hashDeviceId(cliDeviceId);
        const pairEntry = this.pairedDevices.get(cliHashForPair);
        if (pairEntry) {
          // pairEntry.mobileDeviceId is the hashed mobile ID — scan sockets by raw auth
          const mobileSocketId = this.findMobileSocketForDeviceHash(pairEntry.mobileDeviceId);
          if (mobileSocketId) {
            client.emit('mobile_connected', { deviceId: pairEntry.mobileDeviceId });

            // Retroactive relay auth: if mobile connected before CLI had a userId, set it now
            if (client.userId) {
              const mobileSocket = this.connectedSockets.get(mobileSocketId);
              if (mobileSocket && !mobileSocket.userId) {
                mobileSocket.userId = client.userId;
                if (!this.userConnections.has(client.userId)) {
                  this.userConnections.set(client.userId, new Set());
                }
                this.userConnections.get(client.userId)!.add(mobileSocketId);
                mobileSocket.join(`user:${client.userId}`);
                this.logger.log(`Retroactively set userId for mobile socket ${mobileSocketId} from CLI ${truncateId(cliDeviceId)}`);
              }
            }
          }
        }

        this.logger.log(`CLI client connected: device=${cliDeviceId} (socket: ${client.id})`);
        return;
      }

      // Cloud relay: route mobile to paired CLI (if mobile has a relay token or known mobileDeviceId)
      const mobileDeviceIdAuth = client.handshake.auth?.mobileDeviceId as string | undefined;
      const mobileRelayToken = client.handshake.auth?.relayToken as string | undefined;
      if (mobileDeviceIdAuth && rawClientType === 'mobile') {
        // Look up pairing using hashed mobile ID
        const mobileHash = hashDeviceId(mobileDeviceIdAuth);
        const pairedCliHash = this.mobileToCli.get(mobileHash);
        if (pairedCliHash) {
          const pair = this.pairedDevices.get(pairedCliHash);
          if (pair) {
            // Verify relay token if provided — auto-heal on mismatch for known devices
            if (mobileRelayToken && pair.mobileRelayToken !== mobileRelayToken) {
              this.logger.log(`Mobile ${truncateId(mobileDeviceIdAuth)} relay token mismatch — updating stored token`);
              pair.mobileRelayToken = mobileRelayToken;
              this.prisma.cloudPairing.updateMany({
                where: { mobileDeviceHash: mobileHash },
                data: { mobileRelayToken },
              }).catch((err) =>
                this.logger.error(`Failed to update mobile relay token: ${err instanceof Error ? err.message : String(err)}`),
              );
            }

            // Resolve raw CLI device ID from live routing maps for Socket.io room join
            const rawCliDeviceId = this.findRawCliDeviceIdByHash(pairedCliHash);
            if (rawCliDeviceId) {
              // Join mobile into CLI's device room for event routing
              client.join(`device:${rawCliDeviceId}`);

              // Notify CLI that mobile is connected
              const cliSocket = this.cliClientSockets.get(rawCliDeviceId);
              if (cliSocket?.connected) {
                cliSocket.emit('mobile_connected', { deviceId: mobileDeviceIdAuth });
              }

              // Relay auth: derive mobile's userId from the paired CLI device
              // (mobile authenticates via relayToken, not Supabase JWT)
              const resolvedUserId = cliSocket?.userId || this.deviceOwnershipCache.get(rawCliDeviceId)?.userId;
              if (resolvedUserId) {
                client.userId = resolvedUserId;
                if (!this.userConnections.has(resolvedUserId)) {
                  this.userConnections.set(resolvedUserId, new Set());
                }
                this.userConnections.get(resolvedUserId)!.add(client.id);
                client.join(`user:${resolvedUserId}`);
                this.logger.log(`Mobile ${truncateId(mobileDeviceIdAuth)} authenticated via relay (userId: ${truncateId(resolvedUserId)})`);
              } else {
                this.logger.warn(`Mobile ${truncateId(mobileDeviceIdAuth)} routed to CLI ${truncateId(rawCliDeviceId)} but no userId resolved — handlers requiring auth will fail`);
              }

              this.logger.log(`Mobile ${truncateId(mobileDeviceIdAuth)} routed to CLI device ${truncateId(rawCliDeviceId)}`);
            }
          }
        }
      }

      // Get session/device info for CLI connections
      const clientType = rawClientType as 'user-scoped' | 'session-scoped' | undefined;
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
          this.offlineNotified.delete(deviceId);

          // Get device metadata from handshake headers
          const deviceName = client.handshake.headers['x-device-name'] as string || 'CLI Device';
          const devicePlatform = client.handshake.headers['x-device-platform'] as string || 'windows';
          const deviceHostname = client.handshake.headers['x-device-hostname'] as string || undefined;

          try {
            const device = await this.devicesService.updateStatus(deviceId, DeviceStatus.ONLINE);
            // Populate ownership cache
            if (device.userId && device.userId !== 'pending') {
              this.deviceOwnershipCache.set(deviceId, { userId: device.userId, cachedAt: Date.now() });
            }
            // Set client.userId from device if not already set via token
            if (!client.userId && device.userId && device.userId !== 'pending') {
              client.userId = device.userId;
              // Also add to user connections
              if (!this.userConnections.has(device.userId)) {
                this.userConnections.set(device.userId, new Set());
              }
              this.userConnections.get(device.userId)!.add(client.id);
              client.join(`user:${device.userId}`);
              this.logger.log(`Set client.userId from device: ${truncateId(device.userId)}`);
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
            this.logger.error(`Error updating device status: ${error instanceof Error ? error.message : String(error)}`);

            // Auto-register device if it doesn't exist but we have a valid userId
            const effectiveUserId = client.userId || authUserId;
            if (effectiveUserId) {
              this.logger.log(`Auto-registering device ${deviceId} for user ${truncateId(effectiveUserId)}`);
              try {
                const newDevice = await this.devicesService.autoRegister(deviceId, effectiveUserId, {
                  name: deviceName,
                  platform: devicePlatform,
                  hostname: deviceHostname,
                  type: 'desktop',
                });
                this.logger.log(`Device ${deviceId} auto-registered successfully`);
                // Populate ownership cache after auto-register
                this.deviceOwnershipCache.set(deviceId, { userId: effectiveUserId, cachedAt: Date.now() });

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
                this.logger.error(`Failed to auto-register device: ${autoRegisterError instanceof Error ? autoRegisterError.message : String(autoRegisterError)}`);
                // Still set userId from CLI auth as fallback
                if (!client.userId && authUserId) {
                  client.userId = authUserId;
                  if (!this.userConnections.has(authUserId)) {
                    this.userConnections.set(authUserId, new Set());
                  }
                  this.userConnections.get(authUserId)!.add(client.id);
                  client.join(`user:${authUserId}`);
                  this.logger.log(`Set client.userId from CLI auth (auto-register failed): ${truncateId(authUserId)}`);
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
          this.logger.log(`Set client.userId from CLI auth: ${truncateId(authUserId)}`);
        }

        // Join session-specific room
        client.join(`session:${sessionId}`);

        // Also join device room for backward compatibility
        if (deviceId) {
          client.join(`device:${deviceId}`);
        }

        this.logger.log(`Session-scoped CLI connected: session=${sessionId}, device=${deviceId}, userId=${truncateId(client.userId)} (socket: ${client.id})`);

        // Track by userId for cross-device routing (allows mobile to find CLI regardless of deviceId)
        if (client.userId) {
          if (!this.userCliConnections.has(client.userId)) {
            this.userCliConnections.set(client.userId, new Set());
          }
          this.userCliConnections.get(client.userId)!.add(sessionId);
          this.logger.log(`Added CLI session ${sessionId} to user ${truncateId(client.userId)}'s CLI connections`);
        }
      }
      // Handle legacy device-scoped connections
      else if (deviceId) {
        client.deviceId = deviceId;
        client.isDevice = true;
        this.deviceConnections.set(deviceId, client.id);
        this.cancelGraceTimer(deviceId); // Cancel pending offline transition from previous disconnect
        this.offlineNotified.delete(deviceId);

        // Join device room
        client.join(`device:${deviceId}`);

        // Get device metadata from handshake headers
        const deviceName = client.handshake.headers['x-device-name'] as string || 'CLI Device';
        const devicePlatform = client.handshake.headers['x-device-platform'] as string || 'windows';
        const deviceHostname = client.handshake.headers['x-device-hostname'] as string || undefined;

        try {
          // Update device status to online
          const device = await this.devicesService.updateStatus(deviceId, DeviceStatus.ONLINE);
          // Populate ownership cache
          if (device.userId && device.userId !== 'pending') {
            this.deviceOwnershipCache.set(deviceId, { userId: device.userId, cachedAt: Date.now() });
          }

          // Notify user that device is online
          if (device.userId && device.userId !== 'pending') {
            this.server.to(`user:${device.userId}`).emit('device_status', {
              deviceId,
              status: DeviceStatus.ONLINE,
              cliVersion,
            });
          }
        } catch (error) {
          this.logger.error(`Error updating device status: ${error instanceof Error ? error.message : String(error)}`);

          // Auto-register device if it doesn't exist but we have a valid userId
          const effectiveUserId = client.userId || authUserId;
          if (effectiveUserId) {
            this.logger.log(`Auto-registering device ${deviceId} for user ${truncateId(effectiveUserId)}`);
            try {
              const newDevice = await this.devicesService.autoRegister(deviceId, effectiveUserId, {
                name: deviceName,
                platform: devicePlatform,
                hostname: deviceHostname,
                type: 'desktop',
              });
              this.logger.log(`Device ${deviceId} auto-registered successfully`);
              // Populate ownership cache after auto-register
              this.deviceOwnershipCache.set(deviceId, { userId: effectiveUserId, cachedAt: Date.now() });

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
              this.logger.error(`Failed to auto-register device: ${autoRegisterError instanceof Error ? autoRegisterError.message : String(autoRegisterError)}`);
            }
          } else {
            this.logger.warn(`Cannot auto-register device ${deviceId}: no userId available`);
          }
        }

        this.logger.log(`Device ${deviceId} connected (socket: ${client.id})`);
      }
    } catch (error) {
      this.logger.error(`Connection error: ${error instanceof Error ? error.message : String(error)}`);
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
        `User ${truncateId(client.userId)} disconnected (socket: ${client.id})`,
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
          this.logger.log(`Removed CLI session ${client.sessionId} from user ${truncateId(client.userId)}'s CLI connections`);
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
          this.logger.error(`Error handling session disconnect: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Handle device disconnection — use grace period to tolerate brief network blips
    // Skip for session-scoped connections — they don't represent the device going offline
    if (client.deviceId && client.clientType !== 'session-scoped') {
      const disconnectedDeviceId = client.deviceId;
      const disconnectedCliVersion = client.cliVersion;

      // Remove stale socket mapping (reconnect will re-add with new socket ID)
      this.deviceConnections.delete(disconnectedDeviceId);

      // Clear ownership cache so it's re-validated on next connection
      this.deviceOwnershipCache.delete(disconnectedDeviceId);

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
          // Check if device is already offline — skip notification if so
          // (prevents duplicate notifications on server restart)
          const currentDevice = await this.prisma.device.findUnique({
            where: { id: disconnectedDeviceId },
            select: { status: true },
          });
          const wasAlreadyOffline = currentDevice?.status === DeviceStatus.OFFLINE;

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
            this.logger.error(`Error marking sessions inactive: ${error instanceof Error ? error.message : String(error)}`);
          }

          // Notify user that device is offline
          if (device.userId && device.userId !== 'pending') {
            this.server.to(`user:${device.userId}`).emit('device_status', {
              deviceId: disconnectedDeviceId,
              status: DeviceStatus.OFFLINE,
              cliVersion: disconnectedCliVersion,
            });

            // Send push notification only once per offline transition:
            // Skip if device was already offline in DB, or if we already notified for this offline period
            if (!wasAlreadyOffline && !this.offlineNotified.has(disconnectedDeviceId)) {
              this.offlineNotified.add(disconnectedDeviceId);
              this.notificationsService
                .sendPushToUser(
                  device.userId,
                  'Device Offline',
                  `${device.name || 'Your device'} went offline`,
                  { type: 'device_offline', deviceId: disconnectedDeviceId },
                )
                .catch((err) =>
                  this.logger.error(
                    `Failed to send offline push: ${err instanceof Error ? err.message : String(err)}`,
                  ),
                );
            }
          }
        } catch (error) {
          this.logger.error(`Error updating device status: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, WebsocketGateway.DISCONNECT_GRACE_PERIOD_MS);

      this.disconnectGraceTimers.set(disconnectedDeviceId, timer);

      this.logger.log(
        `Device ${client.deviceId} disconnected (socket: ${client.id})`,
      );
    }

    // Clean up CLI cloud relay client connections
    if (client.clientType === 'cli' && client.deviceId) {
      this.cliClientConnections.delete(client.deviceId);
      this.cliClientSockets.delete(client.deviceId);

      // Notify paired mobile that CLI went offline (keyed by hashed ID)
      const cliHash = hashDeviceId(client.deviceId);
      const pair = this.pairedDevices.get(cliHash);
      if (pair) {
        const mobileSocketId = this.findMobileSocketForDeviceHash(pair.mobileDeviceId);
        if (mobileSocketId) {
          const mobileSocket = this.connectedSockets.get(mobileSocketId);
          if (mobileSocket) {
            mobileSocket.emit('mobile_disconnected', {
              deviceId: client.deviceId,
              reason: 'cli_disconnected',
            });
          }
        }
      }
      this.logger.log(`CLI client disconnected: device=${truncateId(client.deviceId)} (socket: ${client.id})`);
    }

    // Notify CLI sessions that mobile user disconnected
    if (client.userId && client.clientType === 'user-scoped') {
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
        this.logger.log(`Notified ${cliSessions.size} CLI session(s) of mobile disconnect for user ${truncateId(client.userId)}`);
      }
    }
  }

  // =============================================
  // Cloud Relay: Pairing & CLI Routing
  // =============================================

  /** CLI registers a pairing code with the relay */
  @SubscribeMessage('register_pairing_code')
  handleRegisterPairingCode(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { code: string; deviceId: string; deviceName: string; platform: string },
  ) {
    if (client.clientType !== 'cli') {
      return { error: 'Only CLI clients can register pairing codes' };
    }

    const code = data.code?.toUpperCase();
    if (!code || code.length < 6 || code.length > 36) {
      return { error: 'Invalid pairing code format' };
    }

    this.pairingCodes.set(code, {
      cliSocketId: client.id,
      cliDeviceId: data.deviceId,
      cliDeviceName: data.deviceName || 'CLI Device',
      platform: data.platform || 'unknown',
      createdAt: Date.now(),
    });

    this.logger.log(`CLI ${data.deviceId} registered pairing code ${code.slice(0, 4)}****`);
    return { success: true };
  }

  /**
   * Mobile sends pair_device — check in-memory pairing codes first (cloud relay flow),
   * then fall through to existing DB-based flow if not found.
   */
  @SubscribeMessage('pair_device')
  async handlePairDevice(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { pairingCode: string; mobileDeviceId: string },
  ) {
    const code = data.pairingCode?.toUpperCase();
    if (!code) {
      return { error: 'Pairing code required' };
    }

    // Check in-memory pairing codes (cloud relay flow)
    const entry = this.pairingCodes.get(code);
    if (entry) {
      // Verify code hasn't expired
      if (Date.now() - entry.createdAt > PAIRING_CODE_TTL_MS) {
        this.pairingCodes.delete(code);
        client.emit('pair_device_reject', { reason: 'Pairing code expired' });
        return { error: 'Pairing code expired' };
      }

      // Generate relay tokens
      const pairId = randomUUID();
      const cliRelayToken = randomBytes(32).toString('hex');
      const mobileRelayToken = randomBytes(32).toString('hex');

      // Hash device IDs for pairing/auth maps and DB storage
      const cliHash = hashDeviceId(entry.cliDeviceId);
      const mobileHash = hashDeviceId(data.mobileDeviceId);

      // Store pairing keyed by hashed CLI device ID
      this.pairedDevices.set(cliHash, {
        mobileDeviceId: mobileHash,
        cliRelayToken,
        mobileRelayToken,
        pairId,
      });

      // Track mobile-to-CLI mapping using hashed IDs
      this.mobileToCli.set(mobileHash, cliHash);

      // Persist to DB (non-blocking — don't fail pairing if DB write fails)
      this.prisma.cloudPairing.create({
        data: {
          cliDeviceHash: cliHash,
          mobileDeviceHash: mobileHash,
          cliRelayToken,
          mobileRelayToken,
          pairId,
        },
      }).catch((err) => {
        this.logger.error(`Failed to persist cloud pairing: ${err instanceof Error ? err.message : String(err)}`);
      });

      // Remove used pairing code
      this.pairingCodes.delete(code);

      // Forward pair_device to CLI socket with mobile info + relay token
      const cliSocket = this.cliClientSockets.get(entry.cliDeviceId) || this.connectedSockets.get(entry.cliSocketId);
      if (cliSocket) {
        cliSocket.emit('pair_device', {
          mobileDeviceId: data.mobileDeviceId,
          pairId,
          cliRelayToken,
        });

        // Wait for CLI ack, then forward to mobile with mobileRelayToken
        cliSocket.once('pair_device_ack', (ackData: any) => {
          client.emit('pair_device_ack', {
            deviceId: ackData.deviceId || entry.cliDeviceId,
            deviceName: ackData.deviceName || entry.cliDeviceName,
            platform: ackData.platform || entry.platform,
            mobileDeviceId: data.mobileDeviceId,
            pairId,
            mobileRelayToken,
          });

          // Join mobile into CLI's device room for event routing
          client.join(`device:${entry.cliDeviceId}`);

          this.logger.log(`Cloud pairing complete: CLI=${entry.cliDeviceId}, mobile=${truncateId(data.mobileDeviceId)}, pair=${pairId}`);

          // Notify CLI that mobile is now connected
          cliSocket.emit('mobile_connected', { deviceId: data.mobileDeviceId });
        });
      } else {
        client.emit('pair_device_reject', { reason: 'CLI device is no longer connected' });
        return { error: 'CLI device disconnected' };
      }

      return { success: true };
    }

    // Not in in-memory store — fall through to legacy DB-based pairing
    // (handled by existing devices controller / service)
    this.logger.log(`Pairing code ${code.slice(0, 4)}**** not in cloud relay — legacy flow`);
    return { error: 'Invalid pairing code' };
  }

  /** Mobile registers its Expo push token for cloud relay push notifications */
  @SubscribeMessage('register_push_token')
  async handleRegisterPushToken(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { token: string; platform: string; mobileDeviceId?: string },
  ) {
    if (!data.token) {
      return { error: 'Push token required' };
    }

    // For authenticated (Supabase) users, use existing PushToken table
    if (client.userId) {
      await this.notificationsService.registerToken(client.userId, data.token, data.platform || 'unknown');
      return { success: true };
    }

    // For cloud relay mobile clients, store on the CloudPairing row
    const mobileDeviceId = data.mobileDeviceId || (client.handshake.auth?.mobileDeviceId as string);
    if (!mobileDeviceId) {
      return { error: 'No mobileDeviceId — cannot associate push token' };
    }

    const mobileHash = hashDeviceId(mobileDeviceId);
    try {
      const updated = await this.prisma.cloudPairing.updateMany({
        where: { mobileDeviceHash: mobileHash },
        data: { expoPushToken: data.token, pushPlatform: data.platform || 'unknown' },
      });
      if (updated.count > 0) {
        this.logger.log(`Stored push token for cloud mobile ${truncateId(mobileDeviceId)}`);
        return { success: true };
      }
      return { error: 'No cloud pairing found for this mobile device' };
    } catch (error) {
      this.logger.error(`Failed to store push token: ${error instanceof Error ? error.message : String(error)}`);
      return { error: 'Failed to store push token' };
    }
  }

  /** Helper: Find mobile socket ID by hashed mobileDeviceId (compares hash of each socket's raw auth ID) */
  private findMobileSocketForDeviceHash(mobileDeviceHash: string): string | null {
    for (const [, socket] of this.connectedSockets) {
      const auth = socket.handshake?.auth;
      if (auth?.clientType === 'mobile' && auth?.mobileDeviceId) {
        if (hashDeviceId(auth.mobileDeviceId as string) === mobileDeviceHash) {
          return socket.id;
        }
      }
    }
    return null;
  }

  /** Helper: Resolve raw CLI device ID from cliClientConnections by comparing hashes */
  private findRawCliDeviceIdByHash(cliHash: string): string | null {
    for (const rawId of this.cliClientConnections.keys()) {
      if (hashDeviceId(rawId) === cliHash) {
        return rawId;
      }
    }
    return null;
  }

  // Mobile app subscribes to device updates
  @SubscribeMessage('subscribe_device')
  async handleSubscribeDevice(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

    client.join(`device:${data.deviceId}`);
    this.logger.log(`Socket ${client.id} subscribed to device ${data.deviceId}`);

    // Send current device status so mobile gets accurate state on subscribe
    const cliSocket = this.cliClientSockets.get(data.deviceId);
    const isOnline = cliSocket?.connected ?? false;
    client.emit('device_status', {
      deviceId: data.deviceId,
      status: isOnline ? DeviceStatus.ONLINE : DeviceStatus.OFFLINE,
    });

    return { success: true };
  }

  @SubscribeMessage('unsubscribe_device')
  async handleUnsubscribeDevice(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }
    client.leave(`device:${data.deviceId}`);
    return { success: true };
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

  onModuleDestroy() {
    // Clear pairing code cleanup interval
    if (this.pairingCodeCleanupInterval) {
      clearInterval(this.pairingCodeCleanupInterval);
      this.pairingCodeCleanupInterval = null;
    }

    // Clear all disconnect grace timers
    for (const [deviceId, timer] of this.disconnectGraceTimers) {
      clearTimeout(timer);
    }
    this.disconnectGraceTimers.clear();
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
    this.logger.debug(`getSessionSocket: sessionId=${sessionId}, hasSocket=${!!socket}, connected=${socket?.connected}, sessionSocketsCount=${this.sessionSockets.size}`);
    if (socket && socket.connected) {
      return socket;
    }
    return undefined;
  }

  // ==================== TERMINAL EVENTS ====================

  // Mobile app requests to create/initialize a terminal session on device
  @SubscribeMessage('terminal_create')
  async handleTerminalCreate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { terminalSessionId: string; deviceId: string; cwd: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleTerminalSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { terminalSessionId: string; deviceId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

    client.join(`terminal:${data.terminalSessionId}`);
    this.logger.log(
      `Socket ${client.id} subscribed to terminal ${data.terminalSessionId}`,
    );
    return { success: true };
  }

  @SubscribeMessage('terminal_unsubscribe')
  async handleTerminalUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { terminalSessionId: string; deviceId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

    client.leave(`terminal:${data.terminalSessionId}`);
    return { success: true };
  }

  // Mobile app sends command to device
  @SubscribeMessage('terminal_command')
  async handleTerminalCommand(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: TerminalCommandPayload & { deviceId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

    // Forward command to the device
    this.sendToDevice(data.deviceId, 'terminal_command', {
      terminalSessionId: data.terminalSessionId,
      command: data.command,
      deviceId: data.deviceId,
      requestedBy: client.userId,
    });

    this.logger.log(
      `Command sent to device ${data.deviceId} (${data.command?.length || 0} chars)`,
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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
        `User message sent to session ${data.sessionKey} (${data.message?.length || 0} chars)`,
      );
    } else {
      // Fallback to device routing
      this.sendToDevice(data.deviceId, 'user_message', payload);
      this.logger.log(
        `User message sent to device ${data.deviceId} (${data.message?.length || 0} chars)`,
      );
    }

    return { success: true };
  }

  // Mobile app sends abort request
  @SubscribeMessage('claude_abort')
  async handleClaudeAbort(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string; sessionKey?: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleClaudeModeChange(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ClaudeModeChangePayload,
  ): Promise<{ success: true } | { error: string }> {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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

    // Update tool status in DB (may fail for cloud-only devices not in devices table)
    try {
      await this.devicesService.updateToolStatus(
        client.deviceId,
        data.toolType,
        data.status,
      );
    } catch {
      // Cloud-paired device not in legacy devices table — skip DB write
    }

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
    this.logger.log(`Received claude_session_update: ${data.sessionKey}, deviceId: ${deviceId}`);

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
  async handleClaudeSessionsRequest(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleDirectoryList(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: { deviceId: string; path: string; requestId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleReadFile(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: { deviceId: string; filePath: string; requestId: string },
  ) {
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleTabComplete(
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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleClaudeResumeSession(
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
    this.logger.log(`Received claude_resume_session from ${truncateId(client.userId)} for device ${data.deviceId}`);
    if (!client.userId) {
      return { error: 'Not authenticated' };
    }
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleClaudeStartSession(
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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleTranscriptFetch(
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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
  async handleTranscriptSubscribe(
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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.logger.log(`Mobile joining room: ${roomName}, userId: ${truncateId(client.userId)}`);

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
  async handleTranscriptUnsubscribe(
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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

    client.leave(`transcript:${data.sessionKey}`);

    this.sendToDevice(data.deviceId, 'transcript_unsubscribe', {
      sessionKey: data.sessionKey,
    });

    return { success: true };
  }

  // Mobile subscribes to SDK streaming session (no transcript file watching)
  // This just joins the room to receive claude_message events from CLI
  @SubscribeMessage('transcript_subscribe_sdk')
  async handleTranscriptSubscribeSdk(
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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.logger.log(`Mobile joining SDK streaming room: ${roomName}, userId: ${truncateId(client.userId)}`);

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
      this.logger.warn(`No CLI connected for user ${truncateId(client.userId)} to start transcript watching`);
    }

    return { success: true };
  }

  // Mobile unsubscribes from SDK streaming session
  @SubscribeMessage('transcript_unsubscribe_sdk')
  async handleTranscriptUnsubscribeSdk(
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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

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
    if (!(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
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
      this.logger.debug(`Looking for CLI by userId ${truncateId(client.userId)}, userSessions: ${userSessions ? Array.from(userSessions) : 'none'}`);
      if (userSessions) {
        for (const sessionId of userSessions) {
          const socket = this.sessionSockets.get(sessionId) as AuthenticatedSocket | undefined;
          if (socket?.connected) {
            cliSocket = socket;
            connectedSessionKey = sessionId;
            this.logger.debug(`Using user's CLI session ${sessionId} for userId ${truncateId(client.userId)}`);
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

    this.logger.debug(`sessionConnections count: ${this.sessionConnections.size}`);
    this.logger.debug(`userCliConnections count: ${this.userCliConnections.size}`);
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
          this.logger.log(`Achievement unlocked: ${unlocked.achievement.key} for user ${truncateId(client.userId)}`);
        }
      } catch (error) {
        this.logger.error(`Failed to record token usage: ${error instanceof Error ? error.message : String(error)}`);
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

    if (targetDeviceId && !(await this.verifyDeviceOwnership(client.userId, targetDeviceId, client))) {
      return { ok: false, error: 'Not authorized for this device' };
    }

    // Determine target socket
    let targetSocket: Socket | undefined;

    if (targetSessionId && this.isSessionConnected(targetSessionId)) {
      targetSocket = this.getSessionSocket(targetSessionId);
      this.logger.log(`RPC call to session ${targetSessionId}: ${method}`);
    } else if (targetDeviceId) {
      const socketId = this.deviceConnections.get(targetDeviceId);
      if (socketId) {
        targetSocket = this.connectedSockets.get(socketId);
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
      this.logger.error(`RPC call failed: ${error instanceof Error ? error.message : String(error)}`);
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
      `Claude approval request: ${data.approvalId} from ${client.deviceId || client.sessionId}, userId: ${truncateId(userId)}`,
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
    this.logger.log(`Sending claude_approval_request ${data.approvalId} to user:${truncateId(userId)}`);

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
      this.logger.error(`Failed to send push notification: ${error instanceof Error ? error.message : String(error)}`);
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
      `Permission prompt from CLI: ${data.toolName} (${data.promptId}) for user ${truncateId(client.userId)}`,
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
      this.logger.error(`Failed to send push notification for permission prompt: ${error instanceof Error ? error.message : String(error)}`);
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
      `Pending permissions sync from CLI: ${data.prompts?.length || 0} prompt(s) for user ${truncateId(client.userId)}`,
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
  async handlePermissionRulesSync(
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
    if (targetDeviceId && !(await this.verifyDeviceOwnership(client.userId, targetDeviceId, client))) {
      return { error: 'Not authorized for this device' };
    }
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
  async handlePermissionResponse(
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
    if (data.deviceId && !(await this.verifyDeviceOwnership(client.userId, data.deviceId, client))) {
      return { error: 'Not authorized for this device' };
    }

    this.logger.log(
      `Permission response: ${data.promptId} -> ${data.decision} from ${truncateId(client.userId)}`,
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
      `Claude approval response: ${data.approvalId} -> ${data.response} from ${truncateId(client.userId)}`,
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
      this.logger.error(`Failed to route approval response for ${data.approvalId}: No connected CLI found (sessionKey=${sessionKey}, deviceId=${data.deviceId}, userId=${truncateId(pending.userId)})`);
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

    this.logger.log(`Rate limit detected for user ${truncateId(client.userId)}: ${data.rateLimitReason}`);

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
      this.logger.error(`Failed to queue prompt: ${error instanceof Error ? error.message : String(error)}`);
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
      this.logger.error(`Failed to execute queue item: ${error instanceof Error ? error.message : String(error)}`);
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
      this.logger.error(`Failed to mark queue item completed: ${error instanceof Error ? error.message : String(error)}`);
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
      identityPublicKey?: string;
      signature?: string;
    },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    if (!data.recipientDeviceId) {
      client.emit('error', { message: 'recipientDeviceId is required' });
      return;
    }
    // Allow if devices are paired (cloud relay) — no userId required for paired devices
    const isPaired = data.senderDeviceId && this.areDevicesPaired(data.senderDeviceId, data.recipientDeviceId);
    if (!isPaired && client.userId) {
      if (data.senderDeviceId && !(await this.verifyDeviceOwnership(client.userId, data.senderDeviceId, client))) {
        return { error: 'Not authorized for this device' };
      }
      if (!(await this.verifyDeviceOwnership(client.userId, data.recipientDeviceId, client))) {
        return { error: 'Not authorized for this device' };
      }
    }

    // Find recipient socket
    const recipientSocket = this.findSocketByDeviceId(data.recipientDeviceId);

    if (recipientSocket) {
      // Forward key exchange init to recipient
      recipientSocket.emit('encrypted_key_exchange_init', {
        senderDeviceId: data.senderDeviceId,
        ephemeralPublicKey: data.ephemeralPublicKey,
        ...(data.identityPublicKey && { identityPublicKey: data.identityPublicKey }),
        ...(data.signature && { signature: data.signature }),
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
      identityPublicKey?: string;
      signature?: string;
    },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    if (!data.recipientDeviceId) {
      client.emit('error', { message: 'recipientDeviceId is required' });
      return;
    }
    const isPairedAck = data.senderDeviceId && this.areDevicesPaired(data.senderDeviceId, data.recipientDeviceId);
    if (!isPairedAck && client.userId) {
      if (data.senderDeviceId && !(await this.verifyDeviceOwnership(client.userId, data.senderDeviceId, client))) {
        return { error: 'Not authorized for this device' };
      }
      if (!(await this.verifyDeviceOwnership(client.userId, data.recipientDeviceId, client))) {
        return { error: 'Not authorized for this device' };
      }
    }

    // Find recipient socket (original sender)
    const recipientSocket = this.findSocketByDeviceId(data.recipientDeviceId);

    if (recipientSocket) {
      recipientSocket.emit('encrypted_key_exchange_ack', {
        senderDeviceId: data.senderDeviceId,
        recipientDeviceId: data.recipientDeviceId,
        ephemeralPublicKey: data.ephemeralPublicKey,
        ...(data.identityPublicKey && { identityPublicKey: data.identityPublicKey }),
        ...(data.signature && { signature: data.signature }),
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
    // Verify sender owns both devices (or they are paired via cloud relay)
    const isPairedMsg = this.areDevicesPaired(data.senderDeviceId, data.recipientDeviceId);
    if (!isPairedMsg && client.userId) {
      if (!(await this.verifyDeviceOwnership(client.userId, data.senderDeviceId, client))) {
        return { error: 'Not authorized for this device' };
      }
      if (!(await this.verifyDeviceOwnership(client.userId, data.recipientDeviceId, client))) {
        return { error: 'Not authorized for this device' };
      }
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
   * Find a socket by device ID (checks CLI devices, session connections, and mobile sockets)
   */
  private findSocketByDeviceId(deviceId: string): AuthenticatedSocket | null {
    // Check CLI/session device connections first
    const socketId = this.deviceConnections.get(deviceId);
    if (socketId) {
      return this.connectedSockets.get(socketId) as AuthenticatedSocket | null;
    }

    // Fallback: scan for mobile socket with matching mobileDeviceId (cloud relay)
    for (const [, socket] of this.connectedSockets) {
      const auth = socket.handshake?.auth;
      if (auth?.clientType === 'mobile' && auth?.mobileDeviceId === deviceId) {
        return socket as AuthenticatedSocket;
      }
    }

    return null;
  }

  /**
   * Check if two device IDs are paired via cloud relay
   */
  private areDevicesPaired(deviceIdA: string, deviceIdB: string): boolean {
    const hashA = hashDeviceId(deviceIdA);
    const hashB = hashDeviceId(deviceIdB);

    // Check if A is mobile paired to B (CLI)
    const pairedCliHash = this.mobileToCli.get(hashA);
    if (pairedCliHash === hashB) return true;

    // Check if B is mobile paired to A (CLI)
    const pairedCliHash2 = this.mobileToCli.get(hashB);
    if (pairedCliHash2 === hashA) return true;

    return false;
  }
}
