/**
 * Tests for WebsocketGateway disconnect grace period
 *
 * Verifies:
 * - Device NOT marked offline immediately on disconnect
 * - Device marked offline after 5s grace period expires
 * - Device NOT marked offline if it reconnects within grace period
 * - Rapid disconnect/reconnect cycles produce only one offline marking
 * - Grace timer map cleaned up after timer fires
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

describe('WebsocketGateway - Disconnect Grace Period', () => {
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
    markAllInactive: jest.fn().mockResolvedValue({ count: 0, sessionKeys: [] }),
  };

  const mockPrismaService = {
    phoneSession: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  // Mock server
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
        { provide: SubscriptionService, useValue: {} },
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

  // Flush microtasks so chained awaits inside the timer callback resolve
  async function flushAsyncTimerCallbacks() {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  function createCliClient(deviceId: string, socketId: string, userId: string = 'user-1') {
    return {
      id: socketId,
      userId,
      deviceId,
      clientType: 'session-scoped' as const,
      sessionId: `session-${socketId}`,
    } as any;
  }

  describe('Grace period timing', () => {
    it('should NOT mark device offline immediately on disconnect', async () => {
      const client = createCliClient('device-123', 'socket-1');

      // Set up the device connection first
      gateway['deviceConnections'].set('device-123', 'socket-1');
      gateway['sessionConnections'].set('session-socket-1', 'socket-1');

      await gateway.handleDisconnect(client);

      // updateStatus should NOT have been called with OFFLINE immediately
      // Note: it may be called with ONLINE for session disconnect handling,
      // but never OFFLINE at this point
      const offlineCalls = mockDevicesService.updateStatus.mock.calls.filter(
        (call: any[]) => call[0] === 'device-123' && call[1] === 'OFFLINE',
      );
      expect(offlineCalls.length).toBe(0);
    });

    it('should mark device offline after 5s grace period expires', async () => {
      const client = createCliClient('device-456', 'socket-2');

      gateway['deviceConnections'].set('device-456', 'socket-2');
      gateway['sessionConnections'].set('session-socket-2', 'socket-2');

      await gateway.handleDisconnect(client);

      // Advance timers by 5 seconds (the grace period)
      jest.advanceTimersByTime(5000);

      // Allow async callback to complete
      await flushAsyncTimerCallbacks();

      // Now updateStatus should have been called with OFFLINE
      expect(mockDevicesService.updateStatus).toHaveBeenCalledWith('device-456', 'OFFLINE');
    });

    it('should NOT mark device offline if it reconnects within grace period', async () => {
      const client = createCliClient('device-789', 'socket-3');

      gateway['deviceConnections'].set('device-789', 'socket-3');
      gateway['sessionConnections'].set('session-socket-3', 'socket-3');

      await gateway.handleDisconnect(client);

      // Simulate device reconnecting within the grace period
      // handleDisconnect deletes the mapping, a new connect would re-add it
      gateway['deviceConnections'].set('device-789', 'new-socket-4');

      // Advance past the grace period
      jest.advanceTimersByTime(5000);
      await flushAsyncTimerCallbacks();

      // updateStatus should NOT have been called with OFFLINE
      // because the grace period callback checks deviceConnections.has()
      const offlineCalls = mockDevicesService.updateStatus.mock.calls.filter(
        (call: any[]) => call[0] === 'device-789' && call[1] === 'OFFLINE',
      );
      expect(offlineCalls.length).toBe(0);
    });
  });

  describe('Rapid disconnect/reconnect cycles', () => {
    it('should cancel previous grace timer on rapid disconnect', async () => {
      const client1 = createCliClient('device-rapid', 'socket-10');
      const client2 = createCliClient('device-rapid', 'socket-11');

      gateway['deviceConnections'].set('device-rapid', 'socket-10');
      gateway['sessionConnections'].set('session-socket-10', 'socket-10');

      // First disconnect
      await gateway.handleDisconnect(client1);

      // Simulate reconnect + second disconnect quickly
      gateway['deviceConnections'].set('device-rapid', 'socket-11');
      gateway['sessionConnections'].set('session-socket-11', 'socket-11');
      await gateway.handleDisconnect(client2);

      // Advance past the grace period
      jest.advanceTimersByTime(5000);
      await flushAsyncTimerCallbacks();

      // Should only have ONE offline call (from the second timer),
      // not two (first timer was cancelled)
      const offlineCalls = mockDevicesService.updateStatus.mock.calls.filter(
        (call: any[]) => call[0] === 'device-rapid' && call[1] === 'OFFLINE',
      );
      expect(offlineCalls.length).toBe(1);
    });

    it('should not produce offline marking if reconnect happens before second grace period expires', async () => {
      const client1 = createCliClient('device-bounce', 'socket-20');

      gateway['deviceConnections'].set('device-bounce', 'socket-20');
      gateway['sessionConnections'].set('session-socket-20', 'socket-20');

      // Disconnect
      await gateway.handleDisconnect(client1);

      // Advance 2 seconds (within grace period)
      jest.advanceTimersByTime(2000);

      // Simulate reconnect (device back online)
      gateway['deviceConnections'].set('device-bounce', 'new-socket-21');

      // Advance remaining 3 seconds past original grace period
      jest.advanceTimersByTime(3000);
      await flushAsyncTimerCallbacks();

      // No offline call should have been made
      const offlineCalls = mockDevicesService.updateStatus.mock.calls.filter(
        (call: any[]) => call[0] === 'device-bounce' && call[1] === 'OFFLINE',
      );
      expect(offlineCalls.length).toBe(0);
    });
  });

  describe('Grace timer map cleanup', () => {
    it('should remove timer from map after it fires', async () => {
      const client = createCliClient('device-cleanup', 'socket-30');

      gateway['deviceConnections'].set('device-cleanup', 'socket-30');
      gateway['sessionConnections'].set('session-socket-30', 'socket-30');

      await gateway.handleDisconnect(client);

      // Timer should be in the map
      expect(gateway['disconnectGraceTimers'].has('device-cleanup')).toBe(true);

      // Advance past grace period
      jest.advanceTimersByTime(5000);
      await flushAsyncTimerCallbacks();

      // Timer should be cleaned up from the map
      expect(gateway['disconnectGraceTimers'].has('device-cleanup')).toBe(false);
    });

    it('should remove timer from map when cancelled by cancelGraceTimer', async () => {
      const client = createCliClient('device-cancel', 'socket-40');

      gateway['deviceConnections'].set('device-cancel', 'socket-40');
      gateway['sessionConnections'].set('session-socket-40', 'socket-40');

      await gateway.handleDisconnect(client);

      // Timer should be in the map
      expect(gateway['disconnectGraceTimers'].has('device-cancel')).toBe(true);

      // Cancel the grace timer (as would happen on reconnect)
      gateway['cancelGraceTimer']('device-cancel');

      // Timer should be removed
      expect(gateway['disconnectGraceTimers'].has('device-cancel')).toBe(false);

      // Advance past grace period — should NOT trigger offline since timer was cancelled
      jest.advanceTimersByTime(5000);
      await flushAsyncTimerCallbacks();

      const offlineCalls = mockDevicesService.updateStatus.mock.calls.filter(
        (call: any[]) => call[0] === 'device-cancel' && call[1] === 'OFFLINE',
      );
      expect(offlineCalls.length).toBe(0);
    });
  });

  describe('Session cleanup still works with grace period', () => {
    it('should still mark sessions inactive after grace period expires', async () => {
      mockClaudeSessionsService.markAllInactive.mockResolvedValue({
        count: 2,
        sessionKeys: ['sess-1', 'sess-2'],
      });

      const client = createCliClient('device-sessions', 'socket-50');

      gateway['deviceConnections'].set('device-sessions', 'socket-50');
      gateway['sessionConnections'].set('session-socket-50', 'socket-50');

      await gateway.handleDisconnect(client);

      // Before grace period: markAllInactive should NOT have been called
      expect(mockClaudeSessionsService.markAllInactive).not.toHaveBeenCalled();

      // Advance past grace period
      jest.advanceTimersByTime(5000);
      await flushAsyncTimerCallbacks();

      // After grace period: markAllInactive should have been called
      expect(mockClaudeSessionsService.markAllInactive).toHaveBeenCalledWith('device-sessions');
    });

    it('should emit device_status OFFLINE event after grace period', async () => {
      const client = createCliClient('device-status', 'socket-60');

      gateway['deviceConnections'].set('device-status', 'socket-60');
      gateway['sessionConnections'].set('session-socket-60', 'socket-60');

      await gateway.handleDisconnect(client);

      // Advance past grace period
      jest.advanceTimersByTime(5000);
      await flushAsyncTimerCallbacks();

      // Should have emitted device_status with OFFLINE
      const statusEvents = emittedEvents.filter(
        (e) => e.event === 'device_status' && e.data?.status === 'OFFLINE',
      );
      expect(statusEvents.length).toBe(1);
      expect(statusEvents[0].data.deviceId).toBe('device-status');
    });
  });
});
