import { Test, TestingModule } from '@nestjs/testing';
import { DeviceRegistrationController } from './device-registration.controller';
import { AuthService } from './auth.service';
import { BadRequestException } from '@nestjs/common';

describe('DeviceRegistrationController', () => {
  let controller: DeviceRegistrationController;
  let authService: AuthService;

  const mockAuthService = {
    checkDeviceRegistration: jest.fn(),
    registerDeviceFingerprint: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeviceRegistrationController],
      providers: [
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
      ],
    }).compile();

    controller = module.get<DeviceRegistrationController>(DeviceRegistrationController);
    authService = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkRegistration', () => {
    it('should return allowed: true when device is not registered', async () => {
      mockAuthService.checkDeviceRegistration.mockResolvedValue({ allowed: true });

      const result = await controller.checkRegistration({
        fingerprintHash: 'abc123hash',
      });

      expect(result).toEqual({ allowed: true });
      expect(mockAuthService.checkDeviceRegistration).toHaveBeenCalledWith('abc123hash', undefined);
    });

    it('should return allowed: false with message when device is registered', async () => {
      mockAuthService.checkDeviceRegistration.mockResolvedValue({
        allowed: false,
        message: 'You already have an existing account (jo***@example.com). Please log in instead.',
      });

      const result = await controller.checkRegistration({
        fingerprintHash: 'abc123hash',
      });

      expect(result.allowed).toBe(false);
      expect(result.message).toContain('jo***@example.com');
    });

    it('should pass email to checkDeviceRegistration when provided', async () => {
      mockAuthService.checkDeviceRegistration.mockResolvedValue({ allowed: true });

      const result = await controller.checkRegistration({
        fingerprintHash: 'abc123hash',
        email: 'test@example.com',
      });

      expect(result).toEqual({ allowed: true });
      expect(mockAuthService.checkDeviceRegistration).toHaveBeenCalledWith('abc123hash', 'test@example.com');
    });

    it('should throw BadRequestException when fingerprintHash is missing', async () => {
      await expect(
        controller.checkRegistration({ fingerprintHash: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when fingerprintHash is not a string', async () => {
      await expect(
        controller.checkRegistration({ fingerprintHash: null as any }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('registerFingerprint', () => {
    const mockUser = {
      id: 'user-123',
      email: 'test@example.com',
      username: 'testuser',
    } as any;

    it('should register fingerprint for authenticated user', async () => {
      mockAuthService.registerDeviceFingerprint.mockResolvedValue(undefined);

      const result = await controller.registerFingerprint(mockUser, {
        fingerprintHash: 'abc123hash',
      });

      expect(result).toEqual({ success: true });
      expect(mockAuthService.registerDeviceFingerprint).toHaveBeenCalledWith(
        'user-123',
        'abc123hash',
      );
    });

    it('should throw BadRequestException when fingerprintHash is missing', async () => {
      await expect(
        controller.registerFingerprint(mockUser, { fingerprintHash: '' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
