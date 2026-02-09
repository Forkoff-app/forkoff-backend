import { Test, TestingModule } from '@nestjs/testing';
import { CryptoService } from './crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('CryptoService', () => {
  let service: CryptoService;
  let prisma: PrismaService;

  const mockPrismaService = {
    device: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CryptoService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<CryptoService>(CryptoService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('storePublicKey', () => {
    it('should store public key for device', async () => {
      const deviceId = 'device-123';
      const publicKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='; // Valid 32-byte Base64
      const userId = 'user-123';

      mockPrismaService.device.findUnique.mockResolvedValue({
        id: deviceId,
        userId,
      });

      mockPrismaService.device.update.mockResolvedValue({
        id: deviceId,
        publicKeyX25519: publicKey,
        e2eeKeyVersion: 1,
      });

      const result = await service.storePublicKey(deviceId, publicKey, userId);

      expect(result).toEqual({
        success: true,
        keyVersion: 1,
      });
      expect(mockPrismaService.device.update).toHaveBeenCalledWith({
        where: { id: deviceId },
        data: {
          publicKeyX25519: publicKey,
          e2eeKeyVersion: { increment: 1 },
        },
        select: { e2eeKeyVersion: true },
      });
    });

    it('should validate key format (Base64)', async () => {
      const deviceId = 'device-123';
      const invalidKey = 'not-valid-base64!!!'; // Invalid Base64
      const userId = 'user-123';

      await expect(
        service.storePublicKey(deviceId, invalidKey, userId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should validate key length (32 bytes decoded)', async () => {
      const deviceId = 'device-123';
      const shortKey = Buffer.from('short').toString('base64'); // Too short
      const userId = 'user-123';

      await expect(
        service.storePublicKey(deviceId, shortKey, userId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject if device not found', async () => {
      const deviceId = 'nonexistent';
      const publicKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
      const userId = 'user-123';

      mockPrismaService.device.findUnique.mockResolvedValue(null);

      await expect(
        service.storePublicKey(deviceId, publicKey, userId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject if user does not own device', async () => {
      const deviceId = 'device-123';
      const publicKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
      const userId = 'user-123';

      mockPrismaService.device.findUnique.mockResolvedValue({
        id: deviceId,
        userId: 'different-user',
      });

      await expect(
        service.storePublicKey(deviceId, publicKey, userId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getPublicKey', () => {
    it('should retrieve public key for device', async () => {
      const deviceId = 'device-123';
      const publicKey = 'dGVzdC1wdWJsaWMta2V5LWJhc2U2NA==';

      mockPrismaService.device.findUnique.mockResolvedValue({
        id: deviceId,
        publicKeyX25519: publicKey,
        e2eeKeyVersion: 1,
      });

      const result = await service.getPublicKey(deviceId);

      expect(result).toEqual({
        publicKey,
        keyVersion: 1,
      });
    });

    it('should return null for device without key', async () => {
      const deviceId = 'device-123';

      mockPrismaService.device.findUnique.mockResolvedValue({
        id: deviceId,
        publicKeyX25519: null,
        e2eeKeyVersion: 0,
      });

      const result = await service.getPublicKey(deviceId);

      expect(result).toBeNull();
    });

    it('should throw NotFoundException if device does not exist', async () => {
      const deviceId = 'nonexistent';

      mockPrismaService.device.findUnique.mockResolvedValue(null);

      await expect(service.getPublicKey(deviceId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('key rotation', () => {
    it('should increment key version when updating key', async () => {
      const deviceId = 'device-123';
      const newPublicKey = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='; // Different 32-byte key
      const userId = 'user-123';

      mockPrismaService.device.findUnique.mockResolvedValue({
        id: deviceId,
        userId,
        publicKeyX25519: 'old-key',
        e2eeKeyVersion: 1,
      });

      mockPrismaService.device.update.mockResolvedValue({
        id: deviceId,
        publicKeyX25519: newPublicKey,
        e2eeKeyVersion: 2,
      });

      const result = await service.storePublicKey(
        deviceId,
        newPublicKey,
        userId,
      );

      expect(result.keyVersion).toBe(2);
    });
  });
});
