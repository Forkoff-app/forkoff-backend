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
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DevicesService } from '../devices/devices.service';
import { ClaudeSessionsService } from '../claude-sessions/claude-sessions.service';
import { DeviceStatus, MessageRole, ApprovalType } from '@prisma/client';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  deviceId?: string;
  isDevice?: boolean; // true if connection is from CLI tool, false if from mobile app
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
  changes: any;
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

@WebSocketGateway({
  cors: {
    origin: '*', // Configure properly in production
  },
  namespace: '/',
})
export class WebsocketGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);
  private supabase: SupabaseClient;

  // Track connected clients
  private userConnections = new Map<string, Set<string>>(); // userId -> Set of socket IDs
  private deviceConnections = new Map<string, string>(); // deviceId -> socket ID

  constructor(
    private configService: ConfigService,
    private devicesService: DevicesService,
    private claudeSessionsService: ClaudeSessionsService,
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

      // Check if this is a device connection (CLI tool)
      const deviceId = client.handshake.auth?.deviceId;
      if (deviceId) {
        client.deviceId = deviceId;
        client.isDevice = true;
        this.deviceConnections.set(deviceId, client.id);

        // Update device status to online
        await this.devicesService.updateStatus(deviceId, DeviceStatus.ONLINE);

        // Join device room
        client.join(`device:${deviceId}`);

        // Notify user that device is online
        const device = await this.devicesService.updateStatus(
          deviceId,
          DeviceStatus.ONLINE,
        );
        if (device.userId && device.userId !== 'pending') {
          this.server.to(`user:${device.userId}`).emit('device_status', {
            deviceId,
            status: DeviceStatus.ONLINE,
          });
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

    // Handle device disconnection
    if (client.deviceId) {
      this.deviceConnections.delete(client.deviceId);

      // Update device status to offline
      try {
        const device = await this.devicesService.updateStatus(
          client.deviceId,
          DeviceStatus.OFFLINE,
        );

        // Notify user that device is offline
        if (device.userId && device.userId !== 'pending') {
          this.server.to(`user:${device.userId}`).emit('device_status', {
            deviceId: client.deviceId,
            status: DeviceStatus.OFFLINE,
          });
        }
      } catch (error) {
        this.logger.error(`Error updating device status: ${error}`);
      }

      this.logger.log(
        `Device ${client.deviceId} disconnected (socket: ${client.id})`,
      );
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
  ) {
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
      });
    }

    return { success: true };
  }

  // Device syncing status
  @SubscribeMessage('device_syncing')
  async handleDeviceSyncing(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { syncing: boolean },
  ) {
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
      });
    }

    return { success: true };
  }

  // Helper method to send to specific user
  sendToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  // Helper method to send to specific device
  sendToDevice(deviceId: string, event: string, data: any) {
    this.logger.log(`sendToDevice: ${event} to device:${deviceId}`);
    this.server.to(`device:${deviceId}`).emit(event, data);
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
      requestedBy: client.userId,
    });

    this.logger.log(
      `Command sent to device ${data.deviceId}: ${data.command.substring(0, 50)}`,
    );
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
  async handleClaudeSessionUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      sessionKey: string;
      directory: string;
      state: 'active' | 'inactive' | 'suspended';
      lastUsedAt?: string;
      transcriptPath?: string;
    },
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Upsert session in DB
    const session = await this.claudeSessionsService.upsertSession(
      client.deviceId,
      data,
    );

    // Broadcast to device subscribers
    this.server.to(`device:${client.deviceId}`).emit('claude_session_update', {
      ...session,
      deviceId: client.deviceId,
    });

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

    // Broadcast to device room (mobile app is subscribed)
    this.server.to(`device:${client.deviceId}`).emit('directory_list_response', data);

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

  // Device sends transcript history
  @SubscribeMessage('transcript_history')
  handleTranscriptHistory(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: any,
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    // Broadcast to all subscribers of this transcript
    this.server.to(`transcript:${data.sessionKey}`).emit('transcript_history', data);

    return { success: true };
  }

  // Device sends transcript update (new entry)
  @SubscribeMessage('transcript_update')
  handleTranscriptUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: any,
  ) {
    if (!client.deviceId) {
      return { error: 'Not authenticated as device' };
    }

    const roomName = `transcript:${data.sessionKey}`;
    this.logger.log(
      `Broadcasting transcript_update to room: ${roomName}, type: ${data.entry?.type}`,
    );

    // Broadcast to all subscribers of this transcript
    this.server.to(roomName).emit('transcript_update', data);

    return { success: true };
  }
}
