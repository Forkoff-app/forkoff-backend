import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prismaService: PrismaService;

  const mockPrismaService = {
    pushToken: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFetch.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  describe('registerToken', () => {
    it('should upsert a push token', async () => {
      mockPrismaService.pushToken.upsert.mockResolvedValue({
        id: 'token-id',
        userId: 'user-123',
        token: 'ExponentPushToken[xxx]',
        platform: 'ios',
      });

      await service.registerToken('user-123', 'ExponentPushToken[xxx]', 'ios');

      expect(mockPrismaService.pushToken.upsert).toHaveBeenCalledWith({
        where: {
          userId_token: {
            userId: 'user-123',
            token: 'ExponentPushToken[xxx]',
          },
        },
        update: {
          platform: 'ios',
          updatedAt: expect.any(Date),
        },
        create: {
          userId: 'user-123',
          token: 'ExponentPushToken[xxx]',
          platform: 'ios',
        },
      });
    });

    it('should throw error on database failure', async () => {
      mockPrismaService.pushToken.upsert.mockRejectedValue(new Error('DB error'));

      await expect(
        service.registerToken('user-123', 'token', 'ios'),
      ).rejects.toThrow('DB error');
    });
  });

  describe('unregisterToken', () => {
    it('should delete a push token', async () => {
      mockPrismaService.pushToken.deleteMany.mockResolvedValue({ count: 1 });

      await service.unregisterToken('user-123', 'ExponentPushToken[xxx]');

      expect(mockPrismaService.pushToken.deleteMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          token: 'ExponentPushToken[xxx]',
        },
      });
    });
  });

  describe('getUserTokens', () => {
    it('should return array of tokens', async () => {
      mockPrismaService.pushToken.findMany.mockResolvedValue([
        { token: 'token1' },
        { token: 'token2' },
      ]);

      const tokens = await service.getUserTokens('user-123');

      expect(tokens).toEqual(['token1', 'token2']);
      expect(mockPrismaService.pushToken.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
        select: { token: true },
      });
    });

    it('should return empty array on error', async () => {
      mockPrismaService.pushToken.findMany.mockRejectedValue(new Error('DB error'));

      const tokens = await service.getUserTokens('user-123');

      expect(tokens).toEqual([]);
    });
  });

  describe('sendPushToUser', () => {
    it('should send push notifications to all user tokens', async () => {
      mockPrismaService.pushToken.findMany.mockResolvedValue([
        { token: 'token1' },
        { token: 'token2' },
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { status: 'ok', id: 'receipt1' },
            { status: 'ok', id: 'receipt2' },
          ],
        }),
      });

      await service.sendPushToUser('user-123', 'Test Title', 'Test Body', { key: 'value' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://exp.host/--/api/v2/push/send',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
        }),
      );

      // Verify the body contains correct messages
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody).toHaveLength(2);
      expect(callBody[0]).toEqual(expect.objectContaining({
        to: 'token1',
        title: 'Test Title',
        body: 'Test Body',
        data: { key: 'value' },
        sound: 'default',
        priority: 'high',
      }));
    });

    it('should not send if no tokens found', async () => {
      mockPrismaService.pushToken.findMany.mockResolvedValue([]);

      await service.sendPushToUser('user-123', 'Title', 'Body');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle network errors gracefully', async () => {
      mockPrismaService.pushToken.findMany.mockResolvedValue([{ token: 'token1' }]);
      mockFetch.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await service.sendPushToUser('user-123', 'Title', 'Body');
    });

    it('should handle HTTP errors gracefully', async () => {
      mockPrismaService.pushToken.findMany.mockResolvedValue([{ token: 'token1' }]);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Should not throw
      await service.sendPushToUser('user-123', 'Title', 'Body');
    });

    it('should remove invalid tokens (DeviceNotRegistered)', async () => {
      mockPrismaService.pushToken.findMany.mockResolvedValue([{ token: 'invalid-token' }]);
      mockPrismaService.pushToken.deleteMany.mockResolvedValue({ count: 1 });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              status: 'error',
              message: 'DeviceNotRegistered',
              details: { error: 'DeviceNotRegistered' },
            },
          ],
        }),
      });

      await service.sendPushToUser('user-123', 'Title', 'Body');

      // Wait for async cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockPrismaService.pushToken.deleteMany).toHaveBeenCalledWith({
        where: { token: 'invalid-token' },
      });
    });
  });

  describe('trackPendingApproval', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should track a pending approval', () => {
      const onTimeout = jest.fn();

      service.trackPendingApproval('approval-1', 'user-123', {
        terminalSessionId: 'terminal-1',
        sessionKey: 'session-1',
        context: ['line 1'],
        options: ['y:yes', 'n:no'],
        promptText: 'Continue?',
      }, onTimeout);

      const pending = service.getPendingApproval('approval-1');
      expect(pending).toBeDefined();
      expect(pending?.approvalId).toBe('approval-1');
      expect(pending?.userId).toBe('user-123');
    });

    it('should call onTimeout after 5 minutes', () => {
      const onTimeout = jest.fn();

      service.trackPendingApproval('approval-1', 'user-123', {
        terminalSessionId: 'terminal-1',
        context: [],
        options: [],
        promptText: 'Test',
      }, onTimeout);

      // Fast forward 5 minutes
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(onTimeout).toHaveBeenCalledWith('approval-1');
    });

    it('should replace existing approval with same ID', () => {
      const onTimeout1 = jest.fn();
      const onTimeout2 = jest.fn();

      service.trackPendingApproval('approval-1', 'user-123', {
        terminalSessionId: 'terminal-1',
        context: [],
        options: [],
        promptText: 'First',
      }, onTimeout1);

      service.trackPendingApproval('approval-1', 'user-456', {
        terminalSessionId: 'terminal-2',
        context: [],
        options: [],
        promptText: 'Second',
      }, onTimeout2);

      const pending = service.getPendingApproval('approval-1');
      expect(pending?.userId).toBe('user-456');
      expect(pending?.promptText).toBe('Second');

      // Only second timeout should be active
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(onTimeout1).not.toHaveBeenCalled();
      expect(onTimeout2).toHaveBeenCalled();
    });
  });

  describe('completePendingApproval', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should complete and return pending approval', () => {
      const onTimeout = jest.fn();

      service.trackPendingApproval('approval-1', 'user-123', {
        terminalSessionId: 'terminal-1',
        context: [],
        options: [],
        promptText: 'Test',
      }, onTimeout);

      const completed = service.completePendingApproval('approval-1');

      expect(completed).toBeDefined();
      expect(completed?.approvalId).toBe('approval-1');
      expect(service.getPendingApproval('approval-1')).toBeUndefined();
    });

    it('should clear timeout when completing', () => {
      const onTimeout = jest.fn();

      service.trackPendingApproval('approval-1', 'user-123', {
        terminalSessionId: 'terminal-1',
        context: [],
        options: [],
        promptText: 'Test',
      }, onTimeout);

      service.completePendingApproval('approval-1');

      // Fast forward - timeout should not fire
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('should return undefined for non-existent approval', () => {
      const completed = service.completePendingApproval('non-existent');
      expect(completed).toBeUndefined();
    });
  });

  describe('sendApprovalNotification', () => {
    it('should send notification with truncated prompt text', async () => {
      mockPrismaService.pushToken.findMany.mockResolvedValue([{ token: 'token1' }]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ status: 'ok' }] }),
      });

      const longPrompt = 'A'.repeat(150);

      await service.sendApprovalNotification('user-123', 'approval-1', {
        terminalSessionId: 'terminal-1',
        sessionKey: 'session-1',
        context: [],
        options: ['y:yes', 'n:no'],
        promptText: longPrompt,
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody[0].body).toHaveLength(103); // 100 chars + '...'
      expect(callBody[0].body.endsWith('...')).toBe(true);
    });

    it('should include approval data in notification payload', async () => {
      mockPrismaService.pushToken.findMany.mockResolvedValue([{ token: 'token1' }]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ status: 'ok' }] }),
      });

      await service.sendApprovalNotification('user-123', 'approval-1', {
        terminalSessionId: 'terminal-1',
        sessionKey: 'session-key',
        context: [],
        options: ['y:yes', 'n:no', 'p:plan'],
        promptText: 'Continue?',
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody[0].data).toEqual({
        type: 'claude_approval',
        approvalId: 'approval-1',
        sessionKey: 'session-key',
        terminalSessionId: 'terminal-1',
        options: ['y:yes', 'n:no', 'p:plan'],
      });
    });
  });
});
