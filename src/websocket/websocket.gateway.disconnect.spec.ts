import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebsocketGateway } from './websocket.gateway';
import { DevicesService } from '../devices/devices.service';
import { ClaudeSessionsService } from '../claude-sessions/claude-sessions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AchievementCheckerService } from '../achievements/achievement-checker.service';
import { PromptQueueService } from '../prompt-queue/prompt-queue.service';
import { PrismaService } from '../prisma/prisma.service';

describe('WebsocketGateway - Mobile Disconnect', () => {
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

  const mockPrismaService = {};

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
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    gateway = module.get<WebsocketGateway>(WebsocketGateway);
    gateway['server'] = mockServer as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should emit mobile_disconnected to CLI sessions when mobile disconnects', async () => {
    // Set up a CLI session for user-1
    const cliSessions = new Set(['cli-session-1']);
    gateway['userCliConnections'] = new Map([['user-1', cliSessions]]);

    // Simulate mobile user-scoped disconnect
    const mobileClient = {
      id: 'socket-mobile-1',
      userId: 'user-1',
      clientType: 'user-scoped',
      // No deviceId or sessionId (mobile is user-scoped)
    } as any;

    await gateway.handleDisconnect(mobileClient);

    // Should have emitted mobile_disconnected to the CLI session room
    const disconnectEvents = emittedEvents.filter(e => e.event === 'mobile_disconnected');
    expect(disconnectEvents.length).toBe(1);
    expect(disconnectEvents[0].room).toBe('session:cli-session-1');
    expect(disconnectEvents[0].data).toEqual({
      userId: 'user-1',
      timestamp: expect.any(String),
    });
  });

  it('should emit to ALL CLI sessions for the user', async () => {
    // Set up multiple CLI sessions for user-1
    const cliSessions = new Set(['cli-session-1', 'cli-session-2', 'cli-session-3']);
    gateway['userCliConnections'] = new Map([['user-1', cliSessions]]);

    const mobileClient = {
      id: 'socket-mobile-1',
      userId: 'user-1',
      clientType: 'user-scoped',
    } as any;

    await gateway.handleDisconnect(mobileClient);

    const disconnectEvents = emittedEvents.filter(e => e.event === 'mobile_disconnected');
    expect(disconnectEvents.length).toBe(3);

    const targetRooms = disconnectEvents.map(e => e.room).sort();
    expect(targetRooms).toEqual([
      'session:cli-session-1',
      'session:cli-session-2',
      'session:cli-session-3',
    ]);
  });

  it('should NOT emit for session-scoped (CLI) disconnects', async () => {
    // Set up CLI sessions
    const cliSessions = new Set(['cli-session-1']);
    gateway['userCliConnections'] = new Map([['user-1', cliSessions]]);

    // Simulate CLI session-scoped disconnect (not mobile)
    const cliClient = {
      id: 'socket-cli-1',
      userId: 'user-1',
      sessionId: 'cli-session-1',
      deviceId: 'device-1',
      clientType: 'session-scoped',
    } as any;

    await gateway.handleDisconnect(cliClient);

    const disconnectEvents = emittedEvents.filter(e => e.event === 'mobile_disconnected');
    expect(disconnectEvents.length).toBe(0);
  });

  it('should NOT emit when no CLI sessions exist for user', async () => {
    // No CLI sessions for this user
    gateway['userCliConnections'] = new Map();

    const mobileClient = {
      id: 'socket-mobile-1',
      userId: 'user-1',
      clientType: 'user-scoped',
    } as any;

    await gateway.handleDisconnect(mobileClient);

    const disconnectEvents = emittedEvents.filter(e => e.event === 'mobile_disconnected');
    expect(disconnectEvents.length).toBe(0);
  });
});

describe('WebsocketGateway - Device Disconnect Session Cleanup', () => {
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

  const mockClaudeSessionsService = {
    markAllInactive: jest.fn().mockResolvedValue({ count: 3, sessionKeys: ['session-1', 'session-2', 'session-3'] }),
  };

  const mockPrismaService = {};

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

  // Flush microtasks so the async grace timer callback completes
  async function advancePastGracePeriod() {
    jest.advanceTimersByTime(5000);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    emittedEvents.length = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebsocketGateway,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DevicesService, useValue: mockDevicesService },
        { provide: ClaudeSessionsService, useValue: mockClaudeSessionsService },
        { provide: NotificationsService, useValue: {} },
        { provide: AnalyticsService, useValue: {} },
        { provide: AchievementCheckerService, useValue: {} },
        { provide: PromptQueueService, useValue: {} },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    gateway = module.get<WebsocketGateway>(WebsocketGateway);
    gateway['server'] = mockServer as any;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('should call markAllInactive when a device disconnects (after grace period)', async () => {
    const cliClient = {
      id: 'socket-cli-1',
      userId: 'user-1',
      deviceId: 'device-123',
      clientType: 'session-scoped',
      sessionId: 'session-1',
    } as any;

    await gateway.handleDisconnect(cliClient);
    await advancePastGracePeriod();

    expect(mockClaudeSessionsService.markAllInactive).toHaveBeenCalledWith('device-123');
  });

  it('should NOT call markAllInactive when a non-device client disconnects', async () => {
    const mobileClient = {
      id: 'socket-mobile-1',
      userId: 'user-1',
      clientType: 'user-scoped',
      // No deviceId
    } as any;

    await gateway.handleDisconnect(mobileClient);
    await advancePastGracePeriod();

    expect(mockClaudeSessionsService.markAllInactive).not.toHaveBeenCalled();
  });

  it('should emit claude_session_update for each inactivated session (after grace period)', async () => {
    const cliClient = {
      id: 'socket-cli-1',
      userId: 'user-1',
      deviceId: 'device-123',
      clientType: 'session-scoped',
      sessionId: 'session-1',
    } as any;

    await gateway.handleDisconnect(cliClient);
    await advancePastGracePeriod();

    const sessionUpdates = emittedEvents.filter(e => e.event === 'claude_session_update');
    expect(sessionUpdates.length).toBe(3);
    expect(sessionUpdates.every(e => e.room === 'user:user-1')).toBe(true);
    expect(sessionUpdates.every(e => e.data.state === 'inactive')).toBe(true);
    expect(sessionUpdates.map(e => e.data.sessionKey).sort()).toEqual(['session-1', 'session-2', 'session-3']);
  });

  it('should still update device status even if markAllInactive fails (after grace period)', async () => {
    mockClaudeSessionsService.markAllInactive.mockRejectedValueOnce(new Error('DB error'));

    const cliClient = {
      id: 'socket-cli-1',
      userId: 'user-1',
      deviceId: 'device-123',
      clientType: 'session-scoped',
      sessionId: 'session-1',
    } as any;

    await gateway.handleDisconnect(cliClient);
    await advancePastGracePeriod();

    // Device status should still have been updated (after grace period)
    expect(mockDevicesService.updateStatus).toHaveBeenCalledWith('device-123', 'OFFLINE');
    // And the user should still be notified
    const statusEvents = emittedEvents.filter(e => e.event === 'device_status');
    expect(statusEvents.length).toBe(1);
  });
});
