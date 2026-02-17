/**
 * Tests for WebsocketGateway Connection State Recovery (CSR)
 *
 * Verifies:
 * - Recovered connections skip device status update (no DB call)
 * - Recovered connections restore session/device maps
 * - Non-recovered connections go through full registration
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebsocketGateway } from './websocket.gateway';
import { DevicesService } from '../devices/devices.service';
import { ClaudeSessionsService } from '../claude-sessions/claude-sessions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AchievementCheckerService } from '../achievements/achievement-checker.service';
import { PromptQueueService } from '../prompt-queue/prompt-queue.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PrismaService } from '../prisma/prisma.service';

describe('WebsocketGateway - Connection State Recovery', () => {
  let gateway: WebsocketGateway;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'SUPABASE_URL') return 'http://localhost';
      if (key === 'SUPABASE_SERVICE_KEY') return 'test-key';
      return null;
    }),
  };

  const mockDevicesService = {
    updateStatus: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    findOne: jest.fn(),
  };

  const mockPrismaService = {
    phoneSession: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  // Mock server with room-based emit tracking
  const emittedEvents: Array<{ room: string; event: string; data: any }> = [];
  const mockServer = {
    to: jest.fn((room: string) => ({
      emit: jest.fn((event: string, data: any) => {
        emittedEvents.push({ room, event, data });
      }),
    })),
    sockets: {
      sockets: new Map(),
    },
  };

  beforeEach(async () => {
    emittedEvents.length = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebsocketGateway,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DevicesService, useValue: mockDevicesService },
        { provide: ClaudeSessionsService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: AnalyticsService, useValue: {} },
        { provide: AchievementCheckerService, useValue: {} },
        { provide: PromptQueueService, useValue: {} },
        { provide: SubscriptionService, useValue: {} },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    gateway = module.get<WebsocketGateway>(WebsocketGateway);
    gateway['server'] = mockServer as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Recovered connections (CSR)', () => {
    it('should NOT call updateStatus for recovered connections', async () => {
      const recoveredClient = {
        id: 'socket-recovered-1',
        recovered: true,
        userId: 'user-1',
        handshake: {
          auth: {
            deviceId: 'device-123',
            sessionId: 'session-abc',
            clientType: 'session-scoped',
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(recoveredClient);

      // updateStatus should NOT be called — CSR skips heavy DB operations
      expect(mockDevicesService.updateStatus).not.toHaveBeenCalled();
    });

    it('should restore deviceConnections map for recovered client', async () => {
      const recoveredClient = {
        id: 'socket-recovered-1',
        recovered: true,
        userId: 'user-1',
        handshake: {
          auth: {
            deviceId: 'device-123',
            sessionId: 'session-abc',
            clientType: 'session-scoped',
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(recoveredClient);

      // deviceConnections should have been restored
      expect(gateway['deviceConnections'].get('device-123')).toBe('socket-recovered-1');
    });

    it('should restore sessionConnections map for recovered client', async () => {
      const recoveredClient = {
        id: 'socket-recovered-2',
        recovered: true,
        userId: 'user-1',
        handshake: {
          auth: {
            deviceId: 'device-456',
            sessionId: 'session-xyz',
            clientType: 'session-scoped',
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(recoveredClient);

      // sessionConnections should have been restored
      expect(gateway['sessionConnections'].get('session-xyz')).toBe('socket-recovered-2');
    });

    it('should restore userConnections map for recovered client', async () => {
      const recoveredClient = {
        id: 'socket-recovered-3',
        recovered: true,
        userId: 'user-2',
        handshake: {
          auth: {
            deviceId: 'device-789',
            sessionId: 'session-def',
            clientType: 'session-scoped',
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(recoveredClient);

      // userConnections should include the socket ID
      const userSockets = gateway['userConnections'].get('user-2');
      expect(userSockets).toBeDefined();
      expect(userSockets!.has('socket-recovered-3')).toBe(true);
    });

    it('should restore userCliConnections map for recovered session-scoped client', async () => {
      const recoveredClient = {
        id: 'socket-recovered-4',
        recovered: true,
        userId: 'user-3',
        handshake: {
          auth: {
            deviceId: 'device-cli-1',
            sessionId: 'cli-session-1',
            clientType: 'session-scoped',
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(recoveredClient);

      // userCliConnections should have the session ID
      const cliSessions = gateway['userCliConnections'].get('user-3');
      expect(cliSessions).toBeDefined();
      expect(cliSessions!.has('cli-session-1')).toBe(true);
    });

    it('should cancel pending grace timer on recovered connection', async () => {
      // First, simulate a device with a pending grace timer
      const cancelSpy = jest.spyOn(gateway as any, 'cancelGraceTimer');

      const recoveredClient = {
        id: 'socket-recovered-5',
        recovered: true,
        userId: 'user-1',
        handshake: {
          auth: {
            deviceId: 'device-grace-test',
            sessionId: 'session-grace',
            clientType: 'session-scoped',
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(recoveredClient);

      // cancelGraceTimer should have been called for the device
      expect(cancelSpy).toHaveBeenCalledWith('device-grace-test');
      cancelSpy.mockRestore();
    });

    it('should NOT make phone session upsert for recovered connection', async () => {
      const recoveredClient = {
        id: 'socket-recovered-6',
        recovered: true,
        userId: 'user-1',
        handshake: {
          auth: {
            deviceId: 'device-123',
            sessionId: 'session-abc',
            clientType: 'session-scoped',
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(recoveredClient);

      // No Prisma phone session calls
      expect(mockPrismaService.phoneSession.upsert).not.toHaveBeenCalled();
      expect(mockPrismaService.phoneSession.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('Non-recovered connections (full registration)', () => {
    it('should call updateStatus for non-recovered device connections', async () => {
      const normalClient = {
        id: 'socket-normal-1',
        recovered: false,
        handshake: {
          auth: {
            deviceId: 'device-normal-1',
            sessionId: 'session-normal-1',
            clientType: 'session-scoped',
            // No token, so Supabase auth won't be attempted
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(normalClient);

      // updateStatus SHOULD be called for non-recovered connections
      expect(mockDevicesService.updateStatus).toHaveBeenCalledWith('device-normal-1', 'ONLINE');
    });

    it('should set up deviceConnections for non-recovered device', async () => {
      const normalClient = {
        id: 'socket-normal-2',
        recovered: false,
        handshake: {
          auth: {
            deviceId: 'device-normal-2',
            sessionId: 'session-normal-2',
            clientType: 'session-scoped',
          },
          headers: {},
        },
        join: jest.fn(),
      } as any;

      await gateway.handleConnection(normalClient);

      expect(gateway['deviceConnections'].get('device-normal-2')).toBe('socket-normal-2');
    });
  });
});
