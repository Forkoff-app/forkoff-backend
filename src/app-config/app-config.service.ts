import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface VersionConfig {
  minVersion: string;
  forceUpdate: boolean;
  updateMessage?: string;
}

export interface CliVersionConfig {
  minCliVersion: string;
  updateMessage?: string;
}

export interface TierLimits {
  messagesPerDay: number;
  sessionsPerMonth: number;
  maxProjects: number;
  maxDevices: number;
  repairsPerMonth: number;
  historyRetentionDays: number;
  maxPhoneSessions?: number;
}

export interface SubscriptionLimitsConfig {
  free: TierLimits;
  pro: TierLimits;
}

const DEFAULT_SUBSCRIPTION_LIMITS: SubscriptionLimitsConfig = {
  free: {
    messagesPerDay: 10,
    sessionsPerMonth: 10,
    maxProjects: 2,
    maxDevices: 1,
    repairsPerMonth: 3,
    historyRetentionDays: 7,
  },
  pro: {
    messagesPerDay: -1,
    sessionsPerMonth: -1,
    maxProjects: -1,
    maxDevices: -1,
    repairsPerMonth: -1,
    historyRetentionDays: -1,
    maxPhoneSessions: 1,
  },
};

const DEFAULT_VERSION_CONFIG: VersionConfig = {
  minVersion: '1.0.0',
  forceUpdate: false,
  updateMessage: 'Please update to the latest version for new features and improvements.',
};

const DEFAULT_CLI_VERSION_CONFIG: CliVersionConfig = {
  minCliVersion: '1.0.0',
  updateMessage: 'Please update the ForkOff CLI to continue.',
};

export interface PlanFeatureConfig {
  name: string;
  included: boolean;
}

export interface SubscriptionPlanConfig {
  id: string;
  name: string;
  tier: 'free' | 'pro';
  price: number;
  originalPrice?: number;
  currency: string;
  interval: 'month' | 'year';
  features: PlanFeatureConfig[];
  popular?: boolean;
  badge?: string;
  stripePriceId?: string;
  productId: { ios: string; android: string };
}

export interface SubscriptionPlansConfig {
  plans: SubscriptionPlanConfig[];
  promotionBanner?: {
    text: string;
    backgroundColor?: string;
    textColor?: string;
    expiresAt?: string;
  };
  allowPromotionCodes: boolean;
}

const DEFAULT_PLANS: SubscriptionPlansConfig = {
  plans: [
    {
      id: 'free',
      name: 'Free',
      tier: 'free',
      price: 0,
      currency: 'USD',
      interval: 'month',
      features: [],
      productId: { ios: '', android: '' },
    },
    {
      id: 'pro_monthly',
      name: 'Pro Monthly',
      tier: 'pro',
      price: 9.99,
      currency: 'USD',
      interval: 'month',
      popular: true,
      features: [
        { name: 'Unlimited messages', included: true },
        { name: 'Unlimited sessions', included: true },
        { name: 'Unlimited projects', included: true },
        { name: 'Unlimited paired PCs', included: true },
        { name: 'Unlimited re-pairs', included: true },
        { name: 'Full history retention', included: true },
        { name: 'Single phone session', included: true },
      ],
      productId: { ios: 'com.forkoff.pro.monthly', android: 'com.forkoff.pro.monthly' },
    },
    {
      id: 'pro_yearly',
      name: 'Pro Yearly',
      tier: 'pro',
      price: 99.99,
      currency: 'USD',
      interval: 'year',
      badge: 'BEST VALUE',
      features: [
        { name: 'Everything in Pro Monthly', included: true },
        { name: '2 months free', included: true },
      ],
      productId: { ios: 'com.forkoff.pro.yearly', android: 'com.forkoff.pro.yearly' },
    },
  ],
  allowPromotionCodes: true,
};

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  constructor(private prisma: PrismaService) {}

  async getVersionConfig(): Promise<VersionConfig> {
    try {
      const config = await this.prisma.appConfig.findUnique({
        where: { key: 'version' },
      });

      if (!config) {
        return DEFAULT_VERSION_CONFIG;
      }

      return config.value as unknown as VersionConfig;
    } catch (error) {
      this.logger.error('Failed to get version config:', error instanceof Error ? error.message : String(error));
      return DEFAULT_VERSION_CONFIG;
    }
  }

  async setVersionConfig(config: Partial<VersionConfig>): Promise<VersionConfig> {
    const current = await this.getVersionConfig();
    const updated = { ...current, ...config };

    await this.prisma.appConfig.upsert({
      where: { key: 'version' },
      create: {
        key: 'version',
        value: updated,
        description: 'Minimum app version requirements',
      },
      update: {
        value: updated,
      },
    });

    this.logger.debug(`Version config updated: ${JSON.stringify(updated)}`);
    return updated;
  }

  async getConfig<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const config = await this.prisma.appConfig.findUnique({
        where: { key },
      });

      if (!config) {
        return defaultValue;
      }

      return config.value as T;
    } catch (error) {
      this.logger.error(`Failed to get config ${key}:`, error instanceof Error ? error.message : String(error));
      return defaultValue;
    }
  }

  async setConfig<T>(key: string, value: T, description?: string): Promise<T> {
    await this.prisma.appConfig.upsert({
      where: { key },
      create: {
        key,
        value: value as any,
        description,
      },
      update: {
        value: value as any,
      },
    });

    return value;
  }

  async getCliVersionConfig(): Promise<CliVersionConfig> {
    return this.getConfig<CliVersionConfig>(
      'cli-version',
      DEFAULT_CLI_VERSION_CONFIG,
    );
  }

  async getSubscriptionLimits(): Promise<SubscriptionLimitsConfig> {
    return this.getConfig<SubscriptionLimitsConfig>(
      'subscription-limits',
      DEFAULT_SUBSCRIPTION_LIMITS,
    );
  }

  async setSubscriptionLimits(
    limits: Partial<SubscriptionLimitsConfig>,
  ): Promise<SubscriptionLimitsConfig> {
    const current = await this.getSubscriptionLimits();
    const updated = {
      free: { ...current.free, ...limits.free },
      pro: { ...current.pro, ...limits.pro },
    };
    return this.setConfig(
      'subscription-limits',
      updated,
      'Subscription tier limits (-1 = unlimited)',
    );
  }

  async getSubscriptionPlans(): Promise<SubscriptionPlansConfig> {
    return this.getConfig<SubscriptionPlansConfig>(
      'subscription-plans',
      DEFAULT_PLANS,
    );
  }

  async setSubscriptionPlans(
    config: Partial<SubscriptionPlansConfig>,
  ): Promise<SubscriptionPlansConfig> {
    const current = await this.getSubscriptionPlans();
    const updated: SubscriptionPlansConfig = {
      ...current,
      ...config,
      plans: config.plans ?? current.plans,
    };
    return this.setConfig(
      'subscription-plans',
      updated,
      'Subscription plan definitions and promotion settings',
    );
  }

  async getAllConfigs(): Promise<Record<string, any>> {
    const configs = await this.prisma.appConfig.findMany();
    return configs.reduce(
      (acc, config) => ({
        ...acc,
        [config.key]: config.value,
      }),
      {},
    );
  }
}
