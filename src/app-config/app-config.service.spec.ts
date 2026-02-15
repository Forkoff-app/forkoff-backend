import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigService } from './app-config.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  appConfig: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    findMany: jest.fn(),
  },
};

describe('AppConfigService', () => {
  let service: AppConfigService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppConfigService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AppConfigService>(AppConfigService);
  });

  // ---------------------------------------------------------------
  // getSubscriptionPlans
  // ---------------------------------------------------------------

  it('getSubscriptionPlans — returns DB config when entry exists', async () => {
    const dbPlans = {
      plans: [
        {
          id: 'custom_plan',
          name: 'Custom',
          tier: 'pro',
          price: 19.99,
          currency: 'USD',
          interval: 'month',
          features: [],
          productId: { ios: 'com.custom', android: 'com.custom' },
        },
      ],
      allowPromotionCodes: false,
    };

    mockPrisma.appConfig.findUnique.mockResolvedValueOnce({
      key: 'subscription-plans',
      value: dbPlans,
    });

    const result = await service.getSubscriptionPlans();

    expect(result).toEqual(dbPlans);
    expect(mockPrisma.appConfig.findUnique).toHaveBeenCalledWith({
      where: { key: 'subscription-plans' },
    });
  });

  it('getSubscriptionPlans — returns default when no DB entry', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValueOnce(null);

    const result = await service.getSubscriptionPlans();

    expect(result.allowPromotionCodes).toBe(true);
    expect(result.plans).toHaveLength(3);
    expect(result.plans[0].id).toBe('free');
    expect(result.plans[1].id).toBe('pro_monthly');
    expect(result.plans[1].popular).toBe(true);
    expect(result.plans[2].id).toBe('pro_yearly');
    expect(result.plans[2].badge).toBe('BEST VALUE');
  });

  it('getSubscriptionPlans — returns default on DB error', async () => {
    mockPrisma.appConfig.findUnique.mockRejectedValueOnce(
      new Error('Connection refused'),
    );

    const result = await service.getSubscriptionPlans();

    expect(result.allowPromotionCodes).toBe(true);
    expect(result.plans).toHaveLength(3);
    expect(result.plans[0].id).toBe('free');
  });

  // ---------------------------------------------------------------
  // setSubscriptionPlans
  // ---------------------------------------------------------------

  it('setSubscriptionPlans — merges partial update (e.g. just allowPromotionCodes)', async () => {
    // First call: getSubscriptionPlans -> getConfig -> findUnique returns null (use defaults)
    mockPrisma.appConfig.findUnique.mockResolvedValueOnce(null);
    mockPrisma.appConfig.upsert.mockResolvedValueOnce({});

    const result = await service.setSubscriptionPlans({
      allowPromotionCodes: false,
    });

    // Plans should remain the 3 defaults; only allowPromotionCodes changed
    expect(result.allowPromotionCodes).toBe(false);
    expect(result.plans).toHaveLength(3);
    expect(result.plans[0].id).toBe('free');
    expect(result.plans[1].id).toBe('pro_monthly');
    expect(result.plans[2].id).toBe('pro_yearly');

    expect(mockPrisma.appConfig.upsert).toHaveBeenCalledWith({
      where: { key: 'subscription-plans' },
      create: {
        key: 'subscription-plans',
        value: result,
        description: 'Subscription plan definitions and promotion settings',
      },
      update: {
        value: result,
      },
    });
  });

  it('setSubscriptionPlans — replaces plans array when provided', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValueOnce(null);
    mockPrisma.appConfig.upsert.mockResolvedValueOnce({});

    const newPlans = [
      {
        id: 'enterprise',
        name: 'Enterprise',
        tier: 'pro' as const,
        price: 49.99,
        currency: 'USD',
        interval: 'month' as const,
        features: [{ name: 'Everything', included: true }],
        productId: { ios: 'com.enterprise', android: 'com.enterprise' },
      },
    ];

    const result = await service.setSubscriptionPlans({ plans: newPlans });

    // Plans array should be fully replaced, not merged with defaults
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].id).toBe('enterprise');
    expect(result.plans[0].price).toBe(49.99);
    // Other fields should keep defaults
    expect(result.allowPromotionCodes).toBe(true);
  });

  // ---------------------------------------------------------------
  // getSubscriptionLimits
  // ---------------------------------------------------------------

  it('getSubscriptionLimits — returns DB config when entry exists', async () => {
    const dbLimits = {
      free: {
        messagesPerDay: 5,
        sessionsPerMonth: 5,
        maxProjects: 1,
        maxDevices: 1,
        repairsPerMonth: 1,
        historyRetentionDays: 3,
      },
      pro: {
        messagesPerDay: -1,
        sessionsPerMonth: -1,
        maxProjects: -1,
        maxDevices: -1,
        repairsPerMonth: -1,
        historyRetentionDays: -1,
        maxPhoneSessions: 2,
      },
    };

    mockPrisma.appConfig.findUnique.mockResolvedValueOnce({
      key: 'subscription-limits',
      value: dbLimits,
    });

    const result = await service.getSubscriptionLimits();

    expect(result).toEqual(dbLimits);
    expect(result.pro.maxPhoneSessions).toBe(2);
    expect(mockPrisma.appConfig.findUnique).toHaveBeenCalledWith({
      where: { key: 'subscription-limits' },
    });
  });

  it('getSubscriptionLimits — returns default when no DB entry', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValueOnce(null);

    const result = await service.getSubscriptionLimits();

    expect(result.free.messagesPerDay).toBe(10);
    expect(result.free.sessionsPerMonth).toBe(10);
    expect(result.free.maxProjects).toBe(2);
    expect(result.free.maxDevices).toBe(1);
    expect(result.free.repairsPerMonth).toBe(3);
    expect(result.free.historyRetentionDays).toBe(7);
    expect(result.pro.messagesPerDay).toBe(-1);
    expect(result.pro.maxPhoneSessions).toBe(1);
  });

  // ---------------------------------------------------------------
  // getVersionConfig
  // ---------------------------------------------------------------

  it('getVersionConfig — returns DB config when entry exists', async () => {
    const dbVersion = {
      minVersion: '2.0.0',
      forceUpdate: true,
      updateMessage: 'Critical update required!',
    };

    mockPrisma.appConfig.findUnique.mockResolvedValueOnce({
      key: 'version',
      value: dbVersion,
    });

    const result = await service.getVersionConfig();

    expect(result).toEqual(dbVersion);
    expect(result.minVersion).toBe('2.0.0');
    expect(result.forceUpdate).toBe(true);
    expect(mockPrisma.appConfig.findUnique).toHaveBeenCalledWith({
      where: { key: 'version' },
    });
  });

  it('getVersionConfig — returns default when no DB entry', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValueOnce(null);

    const result = await service.getVersionConfig();

    expect(result.minVersion).toBe('1.0.0');
    expect(result.forceUpdate).toBe(false);
    expect(result.updateMessage).toBe(
      'Please update to the latest version for new features and improvements.',
    );
  });
});
