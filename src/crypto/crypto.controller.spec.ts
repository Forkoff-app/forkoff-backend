import { Test, TestingModule } from '@nestjs/testing';
import { CryptoController } from './crypto.controller';
import { CryptoService } from './crypto.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('CryptoController', () => {
  let controller: CryptoController;
  let service: CryptoService;

  const mockCryptoService = {
    storePublicKey: jest.fn(),
    getPublicKey: jest.fn(),
  };

  const mockRequest = {
    user: {
      id: 'user-123',
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CryptoController],
      providers: [
        {
          provide: CryptoService,
          useValue: mockCryptoService,
        },
      ],
    }).compile();

    controller = module.get<CryptoController>(CryptoController);
    service = module.get<CryptoService>(CryptoService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('PUT /devices/:id/public-key', () => {
    it('should store the public key', async () => {
      const deviceId = 'device-123';
      const publicKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

      mockCryptoService.storePublicKey.mockResolvedValue({
        success: true,
        keyVersion: 1,
      });

      const result = await controller.storePublicKey(
        deviceId,
        { publicKey },
        mockRequest as any,
      );

      expect(result).toEqual({
        success: true,
        keyVersion: 1,
      });
      expect(service.storePublicKey).toHaveBeenCalledWith(
        deviceId,
        publicKey,
        'user-123',
      );
    });

    it('should require authentication', async () => {
      const deviceId = 'device-123';
      const publicKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

      const unauthenticatedRequest = { user: undefined };

      await expect(
        controller.storePublicKey(
          deviceId,
          { publicKey },
          unauthenticatedRequest as any,
        ),
      ).rejects.toThrow();
    });

    it('should validate key format', async () => {
      const deviceId = 'device-123';
      const invalidKey = 'invalid';

      mockCryptoService.storePublicKey.mockRejectedValue(
        new BadRequestException('Public key must be valid Base64'),
      );

      await expect(
        controller.storePublicKey(
          deviceId,
          { publicKey: invalidKey },
          mockRequest as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should only allow device owner to update key', async () => {
      const deviceId = 'device-123';
      const publicKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

      mockCryptoService.storePublicKey.mockRejectedValue(
        new BadRequestException('You do not own this device'),
      );

      await expect(
        controller.storePublicKey(
          deviceId,
          { publicKey },
          mockRequest as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('GET /devices/:id/public-key', () => {
    it('should return the public key', async () => {
      const deviceId = 'device-123';
      const publicKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

      mockCryptoService.getPublicKey.mockResolvedValue({
        publicKey,
        keyVersion: 1,
      });

      const result = await controller.getPublicKey(deviceId, mockRequest as any);

      expect(result).toEqual({
        publicKey,
        keyVersion: 1,
      });
    });

    it('should return 404 if no key exists', async () => {
      const deviceId = 'device-123';

      mockCryptoService.getPublicKey.mockResolvedValue(null);

      await expect(
        controller.getPublicKey(deviceId, mockRequest as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('should require authentication', async () => {
      const deviceId = 'device-123';
      const unauthenticatedRequest = { user: undefined };

      await expect(
        controller.getPublicKey(deviceId, unauthenticatedRequest as any),
      ).rejects.toThrow();
    });
  });
});
