import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface VersionConfig {
  minVersion: string;
  forceUpdate: boolean;
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
  team: TierLimits;
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
  team: {
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
      this.logger.error('Failed to get version config:', error);
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

    this.logger.log(`Version config updated: ${JSON.stringify(updated)}`);
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
      this.logger.error(`Failed to get config ${key}:`, error);
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
      team: { ...current.team, ...limits.team },
    };
    return this.setConfig(
      'subscription-limits',
      updated,
      'Subscription tier limits (-1 = unlimited)',
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
