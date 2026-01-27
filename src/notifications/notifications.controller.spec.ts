import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notificationsService: NotificationsService;

  const mockNotificationsService = {
    registerToken: jest.fn(),
    unregisterToken: jest.fn(),
  };

  const mockAuthGuard = {
    canActivate: jest.fn(() => true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue(mockAuthGuard)
      .compile();

    controller = module.get<NotificationsController>(NotificationsController);
    notificationsService = module.get<NotificationsService>(NotificationsService);
  });

  describe('registerToken', () => {
    it('should register a push token successfully', async () => {
      mockNotificationsService.registerToken.mockResolvedValue(undefined);

      const mockRequest = {
        user: { id: 'user-123', email: 'test@example.com' },
      } as any;

      const result = await controller.registerToken(mockRequest, {
        token: 'ExponentPushToken[xxx]',
        platform: 'ios',
      });

      expect(result).toEqual({ success: true });
      expect(mockNotificationsService.registerToken).toHaveBeenCalledWith(
        'user-123',
        'ExponentPushToken[xxx]',
        'ios',
      );
    });

    it('should pass through errors from service', async () => {
      mockNotificationsService.registerToken.mockRejectedValue(
        new Error('Service error'),
      );

      const mockRequest = {
        user: { id: 'user-123', email: 'test@example.com' },
      } as any;

      await expect(
        controller.registerToken(mockRequest, {
          token: 'token',
          platform: 'android',
        }),
      ).rejects.toThrow('Service error');
    });
  });

  describe('unregisterToken', () => {
    it('should unregister a push token successfully', async () => {
      mockNotificationsService.unregisterToken.mockResolvedValue(undefined);

      const mockRequest = {
        user: { id: 'user-123', email: 'test@example.com' },
      } as any;

      const result = await controller.unregisterToken(mockRequest, {
        token: 'ExponentPushToken[xxx]',
      });

      expect(result).toEqual({ success: true });
      expect(mockNotificationsService.unregisterToken).toHaveBeenCalledWith(
        'user-123',
        'ExponentPushToken[xxx]',
      );
    });

    it('should pass through errors from service', async () => {
      mockNotificationsService.unregisterToken.mockRejectedValue(
        new Error('Unregister failed'),
      );

      const mockRequest = {
        user: { id: 'user-123', email: 'test@example.com' },
      } as any;

      await expect(
        controller.unregisterToken(mockRequest, {
          token: 'token',
        }),
      ).rejects.toThrow('Unregister failed');
    });
  });
});
