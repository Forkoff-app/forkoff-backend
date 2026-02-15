import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeoIpService } from '../geo-ip/geo-ip.service';

describe('AuthService - Device Fingerprint', () => {
  let service: AuthService;

  const mockPrismaService = {
    deviceFingerprint: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    pushToken: {
      deleteMany: jest.fn(),
    },
  };

  const mockGeoIpService = {
    getCountryFromIp: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: GeoIpService, useValue: mockGeoIpService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkDeviceRegistration', () => {
    it('should return allowed: true when no fingerprint exists', async () => {
      mockPrismaService.deviceFingerprint.findFirst.mockResolvedValue(null);

      const result = await service.checkDeviceRegistration('somehash');

      expect(result).toEqual({ allowed: true });
      expect(mockPrismaService.deviceFingerprint.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            fingerprintHash: 'somehash',
          }),
        }),
      );
    });

    it('should return allowed: false when fingerprint exists within 40 days', async () => {
      mockPrismaService.deviceFingerprint.findFirst.mockResolvedValue({
        id: 'fp-1',
        fingerprintHash: 'somehash',
        userId: 'user-1',
        registeredAt: new Date(),
        user: { email: 'john@example.com' },
      });

      const result = await service.checkDeviceRegistration('somehash');

      expect(result.allowed).toBe(false);
      expect(result.message).toContain('jo***@example.com');
    });

    it('should return allowed: true when fingerprint is older than 40 days', async () => {
      // findFirst with gte: cutoff will not match old records, so it returns null
      mockPrismaService.deviceFingerprint.findFirst.mockResolvedValue(null);

      const result = await service.checkDeviceRegistration('somehash');

      expect(result).toEqual({ allowed: true });
    });

    it('should mask email correctly', async () => {
      mockPrismaService.deviceFingerprint.findFirst.mockResolvedValue({
        id: 'fp-1',
        fingerprintHash: 'somehash',
        userId: 'user-1',
        registeredAt: new Date(),
        user: { email: 'ab@domain.org' },
      });

      const result = await service.checkDeviceRegistration('somehash');

      expect(result.allowed).toBe(false);
      expect(result.message).toContain('ab***@domain.org');
    });

    it('should mask single-character email local part gracefully', async () => {
      mockPrismaService.deviceFingerprint.findFirst.mockResolvedValue({
        id: 'fp-1',
        fingerprintHash: 'somehash',
        userId: 'user-1',
        registeredAt: new Date(),
        user: { email: 'a@x.com' },
      });

      const result = await service.checkDeviceRegistration('somehash');

      expect(result.allowed).toBe(false);
      // 'a' has length 1, substring(0,2) returns 'a'
      expect(result.message).toContain('a***@x.com');
    });

    it('should allow login when email matches the fingerprint owner', async () => {
      mockPrismaService.deviceFingerprint.findFirst.mockResolvedValue({
        id: 'fp-1',
        fingerprintHash: 'somehash',
        userId: 'user-1',
        registeredAt: new Date(),
        user: { email: 'john@example.com' },
      });

      const result = await service.checkDeviceRegistration('somehash', 'john@example.com');

      expect(result.allowed).toBe(true);
    });

    it('should allow login with case-insensitive email matching', async () => {
      mockPrismaService.deviceFingerprint.findFirst.mockResolvedValue({
        id: 'fp-1',
        fingerprintHash: 'somehash',
        userId: 'user-1',
        registeredAt: new Date(),
        user: { email: 'John@Example.com' },
      });

      const result = await service.checkDeviceRegistration('somehash', 'john@example.com');

      expect(result.allowed).toBe(true);
    });

    it('should block login when email does not match the fingerprint owner', async () => {
      mockPrismaService.deviceFingerprint.findFirst.mockResolvedValue({
        id: 'fp-1',
        fingerprintHash: 'somehash',
        userId: 'user-1',
        registeredAt: new Date(),
        user: { email: 'john@example.com' },
      });

      const result = await service.checkDeviceRegistration('somehash', 'other@example.com');

      expect(result.allowed).toBe(false);
      expect(result.message).toContain('linked to another account');
      expect(result.message).toContain('jo***@example.com');
    });
  });

  describe('registerDeviceFingerprint', () => {
    it('should create a fingerprint record', async () => {
      mockPrismaService.deviceFingerprint.create.mockResolvedValue({
        id: 'fp-1',
        userId: 'user-1',
        fingerprintHash: 'myhash',
        registeredAt: new Date(),
      });

      await service.registerDeviceFingerprint('user-1', 'myhash');

      expect(mockPrismaService.deviceFingerprint.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          fingerprintHash: 'myhash',
        },
      });
    });
  });
});
