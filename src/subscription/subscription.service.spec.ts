import { Test, TestingModule } from '@nestjs/testing';
import { SubscriptionService } from './subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app-config/app-config.service';
import { FREE_LIMITS, PRO_LIMITS } from './constants';

describe('SubscriptionService', () => {
  let service: SubscriptionService;

  const mockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    subscriptionUsage: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    project: { count: jest.fn() },
    device: { count: jest.fn() },
  };

  const mockAppConfig = {
    getSubscriptionLimits: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AppConfigService, useValue: mockAppConfig },
      ],
    }).compile();

    service = module.get<SubscriptionService>(SubscriptionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helper: default DB config returned by AppConfigService
  // ---------------------------------------------------------------------------
  const dbFreeLimits = {
    messagesPerDay: 10,
    sessionsPerMonth: 10,
    maxProjects: 2,
    maxDevices: 1,
    repairsPerMonth: 3,
    historyRetentionDays: 7,
  };

  const dbProLimits = {
    messagesPerDay: -1,
    sessionsPerMonth: -1,
    maxProjects: -1,
    maxDevices: -1,
    repairsPerMonth: -1,
    historyRetentionDays: -1,
    maxPhoneSessions: 1,
  };

  // Helper: a valid usage record with future reset dates
  function makeUsage(overrides: Record<string, any> = {}) {
    return {
      userId: 'user-1',
      messagesUsedToday: 0,
      sessionsUsedThisMonth: 0,
      repairsUsedThisMonth: 0,
      messageLimitResetAt: new Date('2099-01-01'),
      monthlyLimitResetAt: new Date('2099-01-01'),
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // getLimitsForTier
  // ---------------------------------------------------------------------------
  describe('getLimitsForTier', () => {
    it('should return DB limits for free tier (maps -1 to Infinity)', async () => {
      mockAppConfig.getSubscriptionLimits.mockResolvedValue({
        free: dbFreeLimits,
        pro: dbProLimits,
      });

      const result = await service.getLimitsForTier('free');

      expect(result).toEqual({
        messagesPerDay: 10,
        sessionsPerMonth: 10,
        maxProjects: 2,
        maxDevices: 1,
        repairsPerMonth: 3,
        historyRetentionDays: 7,
        maxPhoneSessions: undefined,
      });
    });

    it('should return DB limits for pro tier (maps -1 to Infinity)', async () => {
      mockAppConfig.getSubscriptionLimits.mockResolvedValue({
        free: dbFreeLimits,
        pro: dbProLimits,
      });

      const result = await service.getLimitsForTier('pro');

      expect(result).toEqual({
        messagesPerDay: Infinity,
        sessionsPerMonth: Infinity,
        maxProjects: Infinity,
        maxDevices: Infinity,
        repairsPerMonth: Infinity,
        historyRetentionDays: Infinity,
        maxPhoneSessions: 1,
      });
    });

    it('should fall back to hardcoded constants when DB read fails', async () => {
      mockAppConfig.getSubscriptionLimits.mockRejectedValue(
        new Error('DB connection lost'),
      );

      const freeResult = await service.getLimitsForTier('free');
      expect(freeResult).toEqual(FREE_LIMITS);

      mockAppConfig.getSubscriptionLimits.mockRejectedValue(
        new Error('DB connection lost'),
      );

      const proResult = await service.getLimitsForTier('pro');
      expect(proResult).toEqual(PRO_LIMITS);
    });
  });

  // ---------------------------------------------------------------------------
  // getLimitsForUser
  // ---------------------------------------------------------------------------
  describe('getLimitsForUser', () => {
    beforeEach(() => {
      mockAppConfig.getSubscriptionLimits.mockResolvedValue({
        free: dbFreeLimits,
        pro: dbProLimits,
      });
    });

    it('should return pro limits for user with subscription=pro', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'pro',
        isLifetimePro: false,
        proExpiresAt: null,
      });

      const result = await service.getLimitsForUser('user-1');

      expect(result.messagesPerDay).toBe(Infinity);
      expect(result.maxDevices).toBe(Infinity);
    });

    it('should return pro limits for user with isLifetimePro', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: true,
        proExpiresAt: null,
      });

      const result = await service.getLimitsForUser('user-1');

      expect(result.messagesPerDay).toBe(Infinity);
    });

    it('should return pro limits for user with active proExpiresAt (future date)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: new Date('2099-12-31'),
      });

      const result = await service.getLimitsForUser('user-1');

      expect(result.messagesPerDay).toBe(Infinity);
    });

    it('should return free limits for expired proExpiresAt', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: new Date('2020-01-01'),
      });

      const result = await service.getLimitsForUser('user-1');

      expect(result.messagesPerDay).toBe(10);
      expect(result.maxDevices).toBe(1);
    });

    it('should return free limits for a free user with no pro flags', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: null,
      });

      const result = await service.getLimitsForUser('user-1');

      expect(result.messagesPerDay).toBe(10);
      expect(result.maxProjects).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // checkProStatus
  // ---------------------------------------------------------------------------
  describe('checkProStatus', () => {
    it('should return true for lifetime pro', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: true,
        proExpiresAt: null,
      });

      await expect(service.checkProStatus('user-1')).resolves.toBe(true);
    });

    it('should return true for active subscription', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'pro',
        isLifetimePro: false,
        proExpiresAt: null,
      });

      await expect(service.checkProStatus('user-1')).resolves.toBe(true);
    });

    it('should return true for active voucher (future proExpiresAt)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: new Date('2099-12-31'),
      });

      await expect(service.checkProStatus('user-1')).resolves.toBe(true);
    });

    it('should return false for free user with no pro flags', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: null,
      });

      await expect(service.checkProStatus('user-1')).resolves.toBe(false);
    });

    it('should return false for expired proExpiresAt', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: new Date('2020-01-01'),
      });

      await expect(service.checkProStatus('user-1')).resolves.toBe(false);
    });

    it('should return false when user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.checkProStatus('nonexistent')).resolves.toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getOrCreateUsage
  // ---------------------------------------------------------------------------
  describe('getOrCreateUsage', () => {
    it('should create usage record when none exists', async () => {
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(null);

      const created = makeUsage();
      mockPrisma.subscriptionUsage.create.mockResolvedValue(created);

      const result = await service.getOrCreateUsage('user-1');

      expect(mockPrisma.subscriptionUsage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1' }),
        }),
      );
      expect(result).toEqual(created);
    });

    it('should reset daily counter when messageLimitResetAt is in the past', async () => {
      const staleUsage = makeUsage({
        messagesUsedToday: 7,
        messageLimitResetAt: new Date('2020-01-01'), // past
      });
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(staleUsage);

      const resetUsage = makeUsage({ messagesUsedToday: 0 });
      mockPrisma.subscriptionUsage.update.mockResolvedValue(resetUsage);

      const result = await service.getOrCreateUsage('user-1');

      expect(mockPrisma.subscriptionUsage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          data: expect.objectContaining({ messagesUsedToday: 0 }),
        }),
      );
      expect(result.messagesUsedToday).toBe(0);
    });

    it('should reset monthly counters when monthlyLimitResetAt is in the past', async () => {
      const staleUsage = makeUsage({
        sessionsUsedThisMonth: 5,
        repairsUsedThisMonth: 2,
        monthlyLimitResetAt: new Date('2020-01-01'), // past
      });
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(staleUsage);

      const resetUsage = makeUsage({
        sessionsUsedThisMonth: 0,
        repairsUsedThisMonth: 0,
      });
      mockPrisma.subscriptionUsage.update.mockResolvedValue(resetUsage);

      const result = await service.getOrCreateUsage('user-1');

      expect(mockPrisma.subscriptionUsage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionsUsedThisMonth: 0,
            repairsUsedThisMonth: 0,
          }),
        }),
      );
      expect(result.sessionsUsedThisMonth).toBe(0);
      expect(result.repairsUsedThisMonth).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // checkLimit
  // ---------------------------------------------------------------------------
  describe('checkLimit', () => {
    beforeEach(() => {
      // Default: free user
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: null,
      });
      mockAppConfig.getSubscriptionLimits.mockResolvedValue({
        free: dbFreeLimits,
        pro: dbProLimits,
      });
    });

    it('should allow messages_daily when under limit', async () => {
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(
        makeUsage({ messagesUsedToday: 3 }),
      );

      const result = await service.checkLimit('user-1', 'messages_daily');

      expect(result.allowed).toBe(true);
      expect(result.limitType).toBe('messages_daily');
      expect(result.currentUsage).toBe(3);
      expect(result.limit).toBe(10);
    });

    it('should deny messages_daily when at limit', async () => {
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(
        makeUsage({ messagesUsedToday: 10 }),
      );

      const result = await service.checkLimit('user-1', 'messages_daily');

      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(10);
      expect(result.limit).toBe(10);
    });

    it('should allow devices_max when under limit', async () => {
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(makeUsage());
      mockPrisma.device.count.mockResolvedValue(0);

      const result = await service.checkLimit('user-1', 'devices_max');

      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(0);
      expect(result.limit).toBe(1);
    });

    it('should deny devices_max when at limit', async () => {
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(makeUsage());
      mockPrisma.device.count.mockResolvedValue(1);

      const result = await service.checkLimit('user-1', 'devices_max');

      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(1);
      expect(result.limit).toBe(1);
    });

    it('should allow phone_session for pro user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'pro',
        isLifetimePro: false,
        proExpiresAt: null,
      });
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(makeUsage());

      const result = await service.checkLimit('user-1', 'phone_session');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(1);
    });

    it('should deny phone_session for free user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: null,
      });
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(makeUsage());

      const result = await service.checkLimit('user-1', 'phone_session');

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // recordMessageSent
  // ---------------------------------------------------------------------------
  describe('recordMessageSent', () => {
    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'free',
        isLifetimePro: false,
        proExpiresAt: null,
      });
      mockAppConfig.getSubscriptionLimits.mockResolvedValue({
        free: dbFreeLimits,
        pro: dbProLimits,
      });
    });

    it('should increment counter and return allowed when under limit', async () => {
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(
        makeUsage({ messagesUsedToday: 3 }),
      );
      mockPrisma.subscriptionUsage.update.mockResolvedValue(
        makeUsage({ messagesUsedToday: 4 }),
      );

      const result = await service.recordMessageSent('user-1');

      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(4);
      expect(result.limitType).toBe('messages_daily');
      expect(mockPrisma.subscriptionUsage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { messagesUsedToday: { increment: 1 } },
        }),
      );
    });

    it('should return denied when at limit without incrementing', async () => {
      mockPrisma.subscriptionUsage.findUnique.mockResolvedValue(
        makeUsage({ messagesUsedToday: 10 }),
      );

      const result = await service.recordMessageSent('user-1');

      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(10);
      expect(result.limit).toBe(10);
      // Should NOT have called update to increment
      expect(mockPrisma.subscriptionUsage.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { messagesUsedToday: { increment: 1 } },
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // autoDowngradeExpiredPro
  // ---------------------------------------------------------------------------
  describe('autoDowngradeExpiredPro', () => {
    it('should downgrade expired non-lifetime non-Stripe user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'pro',
        isLifetimePro: false,
        proExpiresAt: new Date('2020-01-01'), // expired
        stripeSubscriptionId: null,
      });

      await service.autoDowngradeExpiredPro('user-1');

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { subscription: 'free' },
      });
    });

    it('should not downgrade lifetime pro user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'pro',
        isLifetimePro: true,
        proExpiresAt: new Date('2020-01-01'),
        stripeSubscriptionId: null,
      });

      await service.autoDowngradeExpiredPro('user-1');

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('should not downgrade user with active Stripe subscription', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        subscription: 'pro',
        isLifetimePro: false,
        proExpiresAt: new Date('2020-01-01'),
        stripeSubscriptionId: 'sub_abc123',
      });

      await service.autoDowngradeExpiredPro('user-1');

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });
});
