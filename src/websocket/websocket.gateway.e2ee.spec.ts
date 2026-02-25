import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebsocketGateway } from './websocket.gateway';
import { DevicesService } from '../devices/devices.service';
import { ClaudeSessionsService } from '../claude-sessions/claude-sessions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AchievementCheckerService } from '../achievements/achievement-checker.service';
import { PromptQueueService } from '../prompt-queue/prompt-queue.service';
import { PrismaService } from '../prisma/prisma.service';

describe('WebsocketGateway - E2EE', () => {
  let gateway: WebsocketGateway;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'SUPABASE_URL') return 'http://localhost';
      if (key === 'SUPABASE_SERVICE_KEY') return 'test-key';
      return null;
    }),
  };

  const mockDevicesService = {
    updateDeviceStatus: jest.fn(),
    findOne: jest.fn(),
  };

  const mockSocket = {
    id: 'socket-123',
    userId: 'user-123',
    deviceId: 'device-123',
    emit: jest.fn(),
    join: jest.fn(),
  };

  const mockRecipientSocket = {
    id: 'socket-456',
    userId: 'user-456',
    deviceId: 'device-456',
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebsocketGateway,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DevicesService, useValue: mockDevicesService },
        { provide: ClaudeSessionsService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: AnalyticsService, useValue: {} },
        { provide: AchievementCheckerService, useValue: {} },
        { provide: PromptQueueService, useValue: {} },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    gateway = module.get<WebsocketGateway>(WebsocketGateway);

    // Setup device connections (deviceId -> socketId)
    gateway['deviceConnections'] = new Map([
      ['device-123', 'socket-123'],
      ['device-456', 'socket-456'],
    ]);

    // Setup server.sockets.sockets (socketId -> Socket)
    gateway['server'] = {
      sockets: {
        sockets: new Map([
          ['socket-123', mockSocket],
          ['socket-456', mockRecipientSocket],
        ]),
      },
    } as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('encrypted_key_exchange_init', () => {
    it('should forward key exchange init to recipient device', async () => {
      const payload = {
        senderDeviceId: 'device-123',
        recipientDeviceId: 'device-456',
        ephemeralPublicKey: 'base64-ephemeral-key',
      };

      await gateway.handleEncryptedKeyExchangeInit(payload, mockSocket as any);

      expect(mockRecipientSocket.emit).toHaveBeenCalledWith(
        'encrypted_key_exchange_init',
        {
          senderDeviceId: 'device-123',
          ephemeralPublicKey: 'base64-ephemeral-key',
        },
      );
    });

    it('should reject if recipientDeviceId is missing', async () => {
      const payload = {
        senderDeviceId: 'device-123',
        recipientDeviceId: '',
        ephemeralPublicKey: 'base64-ephemeral-key',
      };

      await gateway.handleEncryptedKeyExchangeInit(payload, mockSocket as any);

      expect(mockSocket.emit).toHaveBeenCalledWith('error', {
        message: 'recipientDeviceId is required',
      });
    });

    it('should handle offline recipient (no-op for now)', async () => {
      const payload = {
        senderDeviceId: 'device-123',
        recipientDeviceId: 'offline-device',
        ephemeralPublicKey: 'base64-ephemeral-key',
      };

      // Should not throw, just silently fail
      await gateway.handleEncryptedKeyExchangeInit(payload, mockSocket as any);

      expect(mockRecipientSocket.emit).not.toHaveBeenCalled();
    });
  });

  describe('encrypted_key_exchange_ack', () => {
    it('should forward key exchange ack to sender', async () => {
      const payload = {
        senderDeviceId: 'device-456', // Sender of ack (recipient of init)
        recipientDeviceId: 'device-123', // Original sender
        ephemeralPublicKey: 'base64-ephemeral-key-ack',
      };

      await gateway.handleEncryptedKeyExchangeAck(
        payload,
        mockRecipientSocket as any,
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('encrypted_key_exchange_ack', {
        senderDeviceId: 'device-456',
        ephemeralPublicKey: 'base64-ephemeral-key-ack',
      });
    });
  });

  describe('encrypted_message', () => {
    it('should forward encrypted message to recipient', async () => {
      const payload = {
        senderDeviceId: 'device-123',
        recipientDeviceId: 'device-456',
        sessionId: 'session-abc',
        payload: {
          ciphertext: 'encrypted-data',
          nonce: 'random-nonce',
          authTag: 'auth-tag',
        },
        messageCounter: 1,
        timestamp: new Date().toISOString(),
      };

      await gateway.handleEncryptedMessage(payload, mockSocket as any);

      expect(mockRecipientSocket.emit).toHaveBeenCalledWith(
        'encrypted_message',
        payload,
      );
    });

    it('should reject if senderDeviceId is missing', async () => {
      const payload = {
        senderDeviceId: '',
        recipientDeviceId: 'device-456',
        sessionId: 'session-abc',
        payload: {
          ciphertext: 'encrypted-data',
          nonce: 'random-nonce',
          authTag: 'auth-tag',
        },
        messageCounter: 1,
        timestamp: new Date().toISOString(),
      };

      await gateway.handleEncryptedMessage(payload, mockSocket as any);

      expect(mockSocket.emit).toHaveBeenCalledWith('error', {
        message: 'senderDeviceId and recipientDeviceId are required',
      });
    });

    it('should not decrypt or modify the payload', async () => {
      const payload = {
        senderDeviceId: 'device-123',
        recipientDeviceId: 'device-456',
        sessionId: 'session-abc',
        payload: {
          ciphertext: 'ENCRYPTED-SECRET-DATA',
          nonce: 'random-nonce',
          authTag: 'auth-tag',
        },
        messageCounter: 1,
        timestamp: new Date().toISOString(),
      };

      await gateway.handleEncryptedMessage(payload, mockSocket as any);

      // Verify the encrypted payload is forwarded as-is
      expect(mockRecipientSocket.emit).toHaveBeenCalledWith(
        'encrypted_message',
        expect.objectContaining({
          payload: {
            ciphertext: 'ENCRYPTED-SECRET-DATA',
            nonce: 'random-nonce',
            authTag: 'auth-tag',
          },
        }),
      );
    });
  });
});
