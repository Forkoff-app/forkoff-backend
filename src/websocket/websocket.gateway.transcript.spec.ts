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

describe('WebsocketGateway - Transcript History Routing', () => {
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
    trySetSessionName: jest.fn(),
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

  beforeEach(async () => {
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
    jest.clearAllMocks();
  });

  const makeClient = (overrides = {}) => ({
    id: 'socket-cli-1',
    userId: 'user-1',
    deviceId: 'device-123',
    clientType: 'session-scoped',
    sessionId: 'session-1',
    ...overrides,
  } as any);

  const makeEntry = (overrides = {}) => ({
    id: 'entry-1',
    type: 'user',
    timestamp: new Date().toISOString(),
    content: { text: 'Hello' },
    ...overrides,
  });

  const makeHistoryPayload = (overrides: any = {}) => ({
    sessionKey: 'session-abc',
    entries: overrides.entries || [
      makeEntry({ id: 'entry-1', type: 'user', content: { text: 'Hello' } }),
      makeEntry({ id: 'entry-2', type: 'assistant', content: { text: 'Hi there' } }),
    ],
    totalEntries: 2,
    offset: 0,
    hasMore: false,
    ...overrides,
  });

  it('should send transcript_history directly to requesting user via sendToUser', () => {
    const client = makeClient();
    const data = makeHistoryPayload({ requestedBy: 'user-42' });

    const result = gateway.handleTranscriptHistory(client, data);

    expect(result).toEqual({ success: true });

    // Should send directly to user room, NOT transcript room
    const userEvents = emittedEvents.filter(e => e.room === 'user:user-42');
    expect(userEvents.length).toBe(1);
    expect(userEvents[0].event).toBe('transcript_history');
    expect(userEvents[0].data.sessionKey).toBe('session-abc');
    expect(userEvents[0].data.entries).toHaveLength(2);

    // Should NOT broadcast to transcript room
    const transcriptEvents = emittedEvents.filter(e => e.room === 'transcript:session-abc');
    expect(transcriptEvents.length).toBe(0);
  });

  it('should fall back to room broadcast when requestedBy is not set', () => {
    const client = makeClient();
    const data = makeHistoryPayload(); // no requestedBy

    gateway.handleTranscriptHistory(client, data);

    // Should broadcast to transcript room
    const transcriptEvents = emittedEvents.filter(e => e.room === 'transcript:session-abc');
    expect(transcriptEvents.length).toBe(1);
    expect(transcriptEvents[0].event).toBe('transcript_history');

    // Should NOT send to any user room
    const userEvents = emittedEvents.filter(e => e.room.startsWith('user:'));
    expect(userEvents.length).toBe(0);
  });

  it('should fall back to room broadcast for system backfill requests', () => {
    const client = makeClient();
    const data = makeHistoryPayload({ requestedBy: '__system_backfill__' });

    gateway.handleTranscriptHistory(client, data);

    // Should broadcast to transcript room (backfill is not a real user)
    const transcriptEvents = emittedEvents.filter(e => e.room === 'transcript:session-abc');
    expect(transcriptEvents.length).toBe(1);

    // Should NOT send to user room
    const userEvents = emittedEvents.filter(e => e.room.startsWith('user:'));
    expect(userEvents.length).toBe(0);
  });

  it('should return error when client has no deviceId', () => {
    const client = makeClient({ deviceId: undefined });
    const data = makeHistoryPayload({ requestedBy: 'user-42' });

    const result = gateway.handleTranscriptHistory(client, data);

    expect(result).toEqual({ error: 'Not authenticated as device' });
    expect(emittedEvents.length).toBe(0);
  });

  it('should call trySetSessionName from the first user entry', () => {
    const client = makeClient();
    const data = makeHistoryPayload({
      requestedBy: 'user-42',
      entries: [
        makeEntry({ id: 'e1', type: 'assistant', content: { text: 'I am Claude' } }),
        makeEntry({ id: 'e2', type: 'user', content: { text: 'Build a todo app' } }),
        makeEntry({ id: 'e3', type: 'user', content: { text: 'Make it fast' } }),
      ],
    });

    gateway.handleTranscriptHistory(client, data);

    expect(mockClaudeSessionsService.trySetSessionName).toHaveBeenCalledWith(
      'device-123',
      'session-abc',
      'Build a todo app',
    );
  });

  it('should not call trySetSessionName when no user entries exist', () => {
    const client = makeClient();
    const data = makeHistoryPayload({
      requestedBy: 'user-42',
      entries: [
        makeEntry({ id: 'e1', type: 'assistant', content: { text: 'Hello' } }),
      ],
    });

    gateway.handleTranscriptHistory(client, data);

    expect(mockClaudeSessionsService.trySetSessionName).not.toHaveBeenCalled();
  });
});
