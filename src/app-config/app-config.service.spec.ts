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
