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

const DEFAULT_VERSION_CONFIG: VersionConfig = {
  minVersion: '1.0.0',
  forceUpdate: false,
  updateMessage: 'Please update to the latest version for new features and improvements.',
};

const DEFAULT_CLI_VERSION_CONFIG: CliVersionConfig = {
  minCliVersion: '1.0.0',
  updateMessage: 'Please update the ForkOff CLI to continue.',
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
