import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebsocketGateway } from './websocket.gateway';
import { DevicesService } from '../devices/devices.service';
import { ClaudeSessionsService } from '../claude-sessions/claude-sessions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Server, Socket } from 'socket.io';

// Mock socket.io
const mockServer = {
  to: jest.fn().mockReturnThis(),
  emit: jest.fn(),
  sockets: {
    sockets: new Map(),
  },
};

const createMockSocket = (overrides = {}): Partial<Socket> & { userId?: string; deviceId?: string; sessionId?: string; isDevice?: boolean; clientType?: string } => ({
  id: 'socket-123',
  handshake: {
    auth: {},
    headers: {},
    time: new Date().toString(),
    address: '127.0.0.1',
    xdomain: false,
    secure: false,
    issued: Date.now(),
    url: '/',
    query: {},
  } as any,
  join: jest.fn(),
  leave: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
  connected: true,
  ...overrides,
});

describe('WebsocketGateway', () => {
  let gateway: WebsocketGateway;
  let devicesService: DevicesService;
  let claudeSessionsService: ClaudeSessionsService;
  let notificationsService: NotificationsService;

  const mockDevicesService = {
    updateStatus: jest.fn(),
    autoRegister: jest.fn(),
    updateToolStatus: jest.fn(),
  };

  const mockClaudeSessionsService = {
    upsertSession: jest.fn(),
    getSessionByKey: jest.fn(),
    storeMessage: jest.fn(),
  };

  const mockNotificationsService = {
    trackPendingApproval: jest.fn(),
    completePendingApproval: jest.fn(),
    sendApprovalNotification: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'SUPABASE_URL') return 'https://test.supabase.co';
      if (key === 'SUPABASE_SERVICE_KEY') return 'test-service-key';
      return null;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebsocketGateway,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DevicesService, useValue: mockDevicesService },
        { provide: ClaudeSessionsService, useValue: mockClaudeSessionsService },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    gateway = module.get<WebsocketGateway>(WebsocketGateway);
    devicesService = module.get<DevicesService>(DevicesService);
    claudeSessionsService = module.get<ClaudeSessionsService>(ClaudeSessionsService);
    notificationsService = module.get<NotificationsService>(NotificationsService);

    // Assign mock server
    (gateway as any).server = mockServer;
  });

  describe('subscribe_device', () => {
    it('should join device room and return success', () => {
      const mockSocket = createMockSocket();

      const result = gateway.handleSubscribeDevice(
        mockSocket as any,
        { deviceId: 'device-123' },
      );

      expect(mockSocket.join).toHaveBeenCalledWith('device:device-123');
      expect(result).toEqual({ success: true });
    });
  });

  describe('unsubscribe_device', () => {
    it('should leave device room and return success', () => {
      const mockSocket = createMockSocket();

      const result = gateway.handleUnsubscribeDevice(
        mockSocket as any,
        { deviceId: 'device-123' },
      );

      expect(mockSocket.leave).toHaveBeenCalledWith('device:device-123');
      expect(result).toEqual({ success: true });
    });
  });

  describe('chat_subscribe', () => {
    it('should join chat room and return success', () => {
      const mockSocket = createMockSocket();

      const result = gateway.handleChatSubscribe(
        mockSocket as any,
        { sessionId: 'session-123' },
      );

      expect(mockSocket.join).toHaveBeenCalledWith('chat:session-123');
      expect(result).toEqual({ success: true });
    });
  });

  describe('chat_message', () => {
    it('should broadcast message to chat room', () => {
      const mockSocket = createMockSocket({ deviceId: 'device-123' });

      const result = gateway.handleChatMessage(mockSocket as any, {
        sessionId: 'session-123',
        content: 'Hello world',
        role: 'user' as any,
        streaming: false,
      });

      expect(mockServer.to).toHaveBeenCalledWith('chat:session-123');
      expect(mockServer.emit).toHaveBeenCalledWith(
        'chat_message',
        expect.objectContaining({
          sessionId: 'session-123',
          content: 'Hello world',
          role: 'user',
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it('should return error if not authenticated as device', () => {
      const mockSocket = createMockSocket(); // No deviceId

      const result = gateway.handleChatMessage(mockSocket as any, {
        sessionId: 'session-123',
        content: 'Hello',
        role: 'user' as any,
      });

      expect(result).toEqual({ error: 'Not authenticated as device' });
    });
  });

  describe('terminal_subscribe', () => {
    it('should join terminal room and return success', () => {
      const mockSocket = createMockSocket();

      const result = gateway.handleTerminalSubscribe(
        mockSocket as any,
        { terminalSessionId: 'terminal-123' },
      );

      expect(mockSocket.join).toHaveBeenCalledWith('terminal:terminal-123');
      expect(result).toEqual({ success: true });
    });
  });

  describe('terminal_command', () => {
    it('should forward command to device', () => {
      const mockSocket = createMockSocket({ userId: 'user-123' });

      const result = gateway.handleTerminalCommand(mockSocket as any, {
        terminalSessionId: 'terminal-123',
        command: 'ls -la',
        deviceId: 'device-123',
      });

      expect(mockServer.to).toHaveBeenCalledWith('device:device-123');
      expect(mockServer.emit).toHaveBeenCalledWith(
        'terminal_command',
        expect.objectContaining({
          terminalSessionId: 'terminal-123',
          command: 'ls -la',
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it('should return error if not authenticated', () => {
      const mockSocket = createMockSocket(); // No userId

      const result = gateway.handleTerminalCommand(mockSocket as any, {
        terminalSessionId: 'terminal-123',
        command: 'ls',
        deviceId: 'device-123',
      });

      expect(result).toEqual({ error: 'Not authenticated' });
    });
  });

  describe('terminal_output', () => {
    it('should broadcast output to terminal subscribers', () => {
      const mockSocket = createMockSocket({ deviceId: 'device-123' });

      const result = gateway.handleTerminalOutput(mockSocket as any, {
        terminalSessionId: 'terminal-123',
        output: 'file1.txt\nfile2.txt',
        type: 'stdout',
      });

      expect(mockServer.to).toHaveBeenCalledWith('terminal:terminal-123');
      expect(mockServer.emit).toHaveBeenCalledWith(
        'terminal_output',
        expect.objectContaining({
          terminalSessionId: 'terminal-123',
          output: 'file1.txt\nfile2.txt',
          type: 'stdout',
        }),
      );
      expect(result).toEqual({ success: true });
    });
  });

  describe('claude_session_update', () => {
    it('should update session and broadcast', async () => {
      const mockSocket = createMockSocket({
        deviceId: 'device-123',
        userId: 'user-123',
      });

      mockClaudeSessionsService.upsertSession.mockResolvedValue({
        sessionKey: 'session-key',
        directory: '/home/user/project',
        state: 'active',
      });

      const result = await gateway.handleClaudeSessionUpdate(mockSocket as any, {
        sessionKey: 'session-key',
        directory: '/home/user/project',
        state: 'active',
      });

      expect(mockClaudeSessionsService.upsertSession).toHaveBeenCalledWith(
        'device-123',
        expect.objectContaining({
          sessionKey: 'session-key',
          directory: '/home/user/project',
        }),
      );
      expect(mockServer.to).toHaveBeenCalledWith('device:device-123');
      expect(result).toEqual({ success: true });
    });

    it('should accept deviceId from body as fallback', async () => {
      const mockSocket = createMockSocket(); // No deviceId on socket

      mockClaudeSessionsService.upsertSession.mockResolvedValue({});

      const result = await gateway.handleClaudeSessionUpdate(mockSocket as any, {
        sessionKey: 'session-key',
        deviceId: 'device-from-body',
        directory: '/home/user/project',
        state: 'active',
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe('claude_approval_request', () => {
    it('should track approval and broadcast to user', async () => {
      const mockSocket = createMockSocket({
        deviceId: 'device-123',
        userId: 'user-123',
      });

      mockNotificationsService.sendApprovalNotification.mockResolvedValue(undefined);

      const result = await gateway.handleClaudeApprovalRequest(mockSocket as any, {
        approvalId: 'approval-1',
        terminalSessionId: 'terminal-123',
        sessionKey: 'session-key',
        context: ['line 1', 'line 2'],
        options: ['y:yes', 'n:no', 'p:plan'],
        promptText: 'Allow this action?',
      });

      expect(mockNotificationsService.trackPendingApproval).toHaveBeenCalledWith(
        'approval-1',
        'user-123',
        expect.objectContaining({
          terminalSessionId: 'terminal-123',
          promptText: 'Allow this action?',
        }),
        expect.any(Function),
      );

      expect(mockServer.to).toHaveBeenCalledWith('transcript:session-key');
      expect(mockServer.to).toHaveBeenCalledWith('user:user-123');
      expect(mockNotificationsService.sendApprovalNotification).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should return error without userId', async () => {
      const mockSocket = createMockSocket({ deviceId: 'device-123' }); // No userId

      const result = await gateway.handleClaudeApprovalRequest(mockSocket as any, {
        approvalId: 'approval-1',
        terminalSessionId: 'terminal-123',
        context: [],
        options: [],
        promptText: 'Test',
      });

      expect(result).toEqual({ error: 'No userId associated with device' });
    });

    it('should return error without device/session', async () => {
      const mockSocket = createMockSocket({ userId: 'user-123' }); // No deviceId or sessionId

      const result = await gateway.handleClaudeApprovalRequest(mockSocket as any, {
        approvalId: 'approval-1',
        terminalSessionId: 'terminal-123',
        context: [],
        options: [],
        promptText: 'Test',
      });

      expect(result).toEqual({ error: 'Not authenticated as device/session' });
    });
  });

  describe('claude_approval_response', () => {
    it('should complete approval and route to CLI', () => {
      const mockSocket = createMockSocket({ userId: 'user-123' });

      mockNotificationsService.completePendingApproval.mockReturnValue({
        approvalId: 'approval-1',
        userId: 'user-123',
        sessionKey: 'session-key',
      });

      // Mock isSessionConnected
      (gateway as any).sessionConnections = new Map([['session-key', 'socket-id']]);
      (gateway as any).sessionSockets = new Map([
        ['session-key', { connected: true }],
      ]);

      const result = gateway.handleClaudeApprovalResponse(mockSocket as any, {
        approvalId: 'approval-1',
        response: 'y',
        sessionKey: 'session-key',
      });

      expect(mockNotificationsService.completePendingApproval).toHaveBeenCalledWith(
        'approval-1',
      );
      expect(mockServer.to).toHaveBeenCalledWith('session:session-key');
      expect(mockServer.emit).toHaveBeenCalledWith(
        'claude_approval_response',
        expect.objectContaining({
          approvalId: 'approval-1',
          response: 'y',
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it('should return error if not authenticated', () => {
      const mockSocket = createMockSocket(); // No userId

      const result = gateway.handleClaudeApprovalResponse(mockSocket as any, {
        approvalId: 'approval-1',
        response: 'n',
      });

      expect(result).toEqual({ error: 'Not authenticated' });
    });

    it('should return error if approval not found', () => {
      const mockSocket = createMockSocket({ userId: 'user-123' });

      mockNotificationsService.completePendingApproval.mockReturnValue(undefined);

      const result = gateway.handleClaudeApprovalResponse(mockSocket as any, {
        approvalId: 'non-existent',
        response: 'y',
      });

      expect(result).toEqual({ error: 'Approval not found or already processed' });
    });
  });

  describe('transcript_subscribe', () => {
    it('should join transcript room and forward to device', () => {
      const mockSocket = createMockSocket({ userId: 'user-123' });

      const result = gateway.handleTranscriptSubscribe(mockSocket as any, {
        deviceId: 'device-123',
        sessionKey: 'session-key',
        transcriptPath: '/path/to/transcript.jsonl',
      });

      expect(mockSocket.join).toHaveBeenCalledWith('transcript:session-key');
      expect(mockServer.to).toHaveBeenCalledWith('device:device-123');
      expect(result).toEqual({ success: true });
    });
  });

  describe('claude_message', () => {
    it('should broadcast message and store in database', async () => {
      const mockSocket = createMockSocket({ deviceId: 'device-123' });

      mockClaudeSessionsService.storeMessage.mockResolvedValue(undefined);

      const result = await gateway.handleClaudeMessage(mockSocket as any, {
        deviceId: 'device-123',
        sessionKey: 'session-key',
        message: {
          id: 'msg-1',
          type: 'assistant',
          content: 'Hello!',
          partial: false,
        },
      });

      expect(mockServer.to).toHaveBeenCalledWith('transcript:session-key');
      expect(mockServer.emit).toHaveBeenCalledWith('claude_message', expect.any(Object));
      expect(mockClaudeSessionsService.storeMessage).toHaveBeenCalledWith(
        'device-123',
        'session-key',
        expect.objectContaining({
          messageId: 'msg-1',
          type: 'assistant',
          content: 'Hello!',
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it('should not store partial messages', async () => {
      const mockSocket = createMockSocket({ deviceId: 'device-123' });

      const result = await gateway.handleClaudeMessage(mockSocket as any, {
        deviceId: 'device-123',
        sessionKey: 'session-key',
        message: {
          id: 'msg-1',
          type: 'assistant',
          content: 'Hello',
          partial: true,
        },
      });

      expect(mockClaudeSessionsService.storeMessage).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('helper methods', () => {
    it('isUserOnline should return true for connected users', () => {
      (gateway as any).userConnections = new Map([
        ['user-123', new Set(['socket-1'])],
      ]);

      expect(gateway.isUserOnline('user-123')).toBe(true);
      expect(gateway.isUserOnline('user-456')).toBe(false);
    });

    it('isDeviceOnline should return true for connected devices', () => {
      (gateway as any).deviceConnections = new Map([
        ['device-123', 'socket-1'],
      ]);

      expect(gateway.isDeviceOnline('device-123')).toBe(true);
      expect(gateway.isDeviceOnline('device-456')).toBe(false);
    });

    it('isSessionConnected should return true for connected sessions', () => {
      (gateway as any).sessionConnections = new Map([
        ['session-123', 'socket-1'],
      ]);

      expect(gateway.isSessionConnected('session-123')).toBe(true);
      expect(gateway.isSessionConnected('session-456')).toBe(false);
    });

    it('sendToUser should emit to user room', () => {
      gateway.sendToUser('user-123', 'test_event', { data: 'test' });

      expect(mockServer.to).toHaveBeenCalledWith('user:user-123');
      expect(mockServer.emit).toHaveBeenCalledWith('test_event', { data: 'test' });
    });

    it('sendToDevice should emit to device room', () => {
      gateway.sendToDevice('device-123', 'test_event', { data: 'test' });

      expect(mockServer.to).toHaveBeenCalledWith('device:device-123');
      expect(mockServer.emit).toHaveBeenCalledWith('test_event', { data: 'test' });
    });

    it('sendToSession should emit to session room', () => {
      gateway.sendToSession('session-123', 'test_event', { data: 'test' });

      expect(mockServer.to).toHaveBeenCalledWith('session:session-123');
      expect(mockServer.emit).toHaveBeenCalledWith('test_event', { data: 'test' });
    });
  });
});
