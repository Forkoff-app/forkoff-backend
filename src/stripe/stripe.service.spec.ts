import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app-config/app-config.service';

const mockStripe = {
  customers: { create: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('stripe', () => {
  const constructor = jest.fn(() => mockStripe);
  return { __esModule: true, default: constructor };
});

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
};

const mockConfigService = {
  get: jest.fn((key: string): string | undefined => {
    const map: Record<string, string> = {
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_PRO_PRICE_ID: 'price_env_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
    };
    return map[key];
  }),
};

const mockAppConfigService = {
  getSubscriptionPlans: jest.fn(),
};

describe('StripeService', () => {
  let service: StripeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AppConfigService, useValue: mockAppConfigService },
      ],
    }).compile();

    service = module.get<StripeService>(StripeService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------- getOrCreateStripeCustomer ----------

  describe('getOrCreateStripeCustomer', () => {
    it('should return existing customer ID when user already has stripeCustomerId', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        stripeCustomerId: 'cus_existing_123',
      });

      const result = await service.getOrCreateStripeCustomer('user-1');

      expect(result).toBe('cus_existing_123');
      expect(mockStripe.customers.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('should create new Stripe customer when user has no stripeCustomerId', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        stripeCustomerId: null,
      });

      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new_456' });
      mockPrisma.user.update.mockResolvedValue({});

      const result = await service.getOrCreateStripeCustomer('user-1');

      expect(result).toBe('cus_new_456');
      expect(mockStripe.customers.create).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'Test User',
        metadata: { userId: 'user-1' },
      });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { stripeCustomerId: 'cus_new_456' },
      });
    });

    it('should throw BadRequestException when user is not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.getOrCreateStripeCustomer('nonexistent-user'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.getOrCreateStripeCustomer('nonexistent-user'),
      ).rejects.toThrow('User not found');
    });
  });

  // ---------- createCheckoutSession ----------

  describe('createCheckoutSession', () => {
    const setupUserForCheckout = () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        stripeCustomerId: 'cus_existing_123',
      });
    };

    it('should create session with valid env price ID and allow_promotion_codes true', async () => {
      setupUserForCheckout();

      mockAppConfigService.getSubscriptionPlans.mockResolvedValue({
        plans: [{ stripePriceId: 'price_env_123' }],
        allowPromotionCodes: true,
      });

      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/session_123',
      });

      const result = await service.createCheckoutSession('user-1', 'price_env_123');

      expect(result).toEqual({ url: 'https://checkout.stripe.com/session_123' });
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_existing_123',
          mode: 'subscription',
          line_items: [{ price: 'price_env_123', quantity: 1 }],
          allow_promotion_codes: true,
          success_url: 'https://forkoff.app/?checkout=success',
          cancel_url: 'https://forkoff.app/?checkout=cancelled',
          subscription_data: { metadata: { userId: 'user-1' } },
          metadata: { userId: 'user-1' },
        }),
      );
    });

    it('should create session with valid DB-only price ID not present in env', async () => {
      setupUserForCheckout();

      mockAppConfigService.getSubscriptionPlans.mockResolvedValue({
        plans: [
          { stripePriceId: 'price_env_123' },
          { stripePriceId: 'price_db_only_789' },
        ],
        allowPromotionCodes: true,
      });

      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/session_db',
      });

      const result = await service.createCheckoutSession('user-1', 'price_db_only_789');

      expect(result).toEqual({ url: 'https://checkout.stripe.com/session_db' });
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: 'price_db_only_789', quantity: 1 }],
        }),
      );
    });

    it('should throw BadRequestException for invalid price ID', async () => {
      setupUserForCheckout();

      mockAppConfigService.getSubscriptionPlans.mockResolvedValue({
        plans: [{ stripePriceId: 'price_env_123' }],
        allowPromotionCodes: true,
      });

      await expect(
        service.createCheckoutSession('user-1', 'price_invalid_999'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createCheckoutSession('user-1', 'price_invalid_999'),
      ).rejects.toThrow('Invalid price ID');
    });

    it('should set allow_promotion_codes to false when DB config says so', async () => {
      setupUserForCheckout();

      mockAppConfigService.getSubscriptionPlans.mockResolvedValue({
        plans: [{ stripePriceId: 'price_env_123' }],
        allowPromotionCodes: false,
      });

      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/session_nopromo',
      });

      await service.createCheckoutSession('user-1', 'price_env_123');

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          allow_promotion_codes: false,
        }),
      );
    });

    it('should fall back to env-only validation when DB read fails', async () => {
      setupUserForCheckout();

      mockAppConfigService.getSubscriptionPlans.mockRejectedValue(
        new Error('DB connection failed'),
      );

      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/session_fallback',
      });

      // env price ID should still work
      const result = await service.createCheckoutSession('user-1', 'price_env_123');
      expect(result).toEqual({ url: 'https://checkout.stripe.com/session_fallback' });

      // DB-only price ID should be rejected since DB failed
      await expect(
        service.createCheckoutSession('user-1', 'price_db_only_789'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when session.url is null', async () => {
      setupUserForCheckout();

      mockAppConfigService.getSubscriptionPlans.mockResolvedValue({
        plans: [{ stripePriceId: 'price_env_123' }],
        allowPromotionCodes: true,
      });

      mockStripe.checkout.sessions.create.mockResolvedValue({ url: null });

      await expect(
        service.createCheckoutSession('user-1', 'price_env_123'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createCheckoutSession('user-1', 'price_env_123'),
      ).rejects.toThrow('Failed to create checkout session');
    });
  });

  // ---------- createPortalSession ----------

  describe('createPortalSession', () => {
    it('should return portal session URL', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        stripeCustomerId: 'cus_existing_123',
      });

      mockStripe.billingPortal.sessions.create.mockResolvedValue({
        url: 'https://billing.stripe.com/portal_session_123',
      });

      const result = await service.createPortalSession('user-1');

      expect(result).toEqual({
        url: 'https://billing.stripe.com/portal_session_123',
      });
      expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_existing_123',
        return_url: 'forkoff://settings/subscription',
      });
    });
  });

  // ---------- handleWebhookEvent ----------

  describe('handleWebhookEvent', () => {
    const rawBody = Buffer.from('raw-body');
    const signature = 'sig_test_123';

    it('should upsert user to pro on subscription.created', async () => {
      const subscription = {
        id: 'sub_123',
        customer: 'cus_existing_123',
        items: {
          data: [
            {
              price: { id: 'price_env_123' },
              current_period_end: 1700000000,
            },
          ],
        },
      };

      mockStripe.webhooks.constructEvent.mockReturnValue({
        type: 'customer.subscription.created',
        data: { object: subscription },
      });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_existing_123',
      });
      mockPrisma.user.update.mockResolvedValue({});

      await service.handleWebhookEvent(rawBody, signature);

      expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith(
        rawBody,
        signature,
        'whsec_test_123',
      );
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          subscription: 'pro',
          stripeSubscriptionId: 'sub_123',
          stripePriceId: 'price_env_123',
          stripeCurrentPeriodEnd: new Date(1700000000 * 1000),
        },
      });
    });

    it('should upsert user to pro on subscription.updated', async () => {
      const subscription = {
        id: 'sub_456',
        customer: 'cus_existing_123',
        items: {
          data: [
            {
              price: { id: 'price_env_123' },
              current_period_end: 1800000000,
            },
          ],
        },
      };

      mockStripe.webhooks.constructEvent.mockReturnValue({
        type: 'customer.subscription.updated',
        data: { object: subscription },
      });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_existing_123',
      });
      mockPrisma.user.update.mockResolvedValue({});

      await service.handleWebhookEvent(rawBody, signature);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          subscription: 'pro',
          stripeSubscriptionId: 'sub_456',
          stripePriceId: 'price_env_123',
          stripeCurrentPeriodEnd: new Date(1800000000 * 1000),
        },
      });
    });

    it('should downgrade free user on subscription.deleted', async () => {
      const subscription = {
        id: 'sub_123',
        customer: 'cus_existing_123',
        items: { data: [] },
      };

      mockStripe.webhooks.constructEvent.mockReturnValue({
        type: 'customer.subscription.deleted',
        data: { object: subscription },
      });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        isLifetimePro: false,
        proExpiresAt: null,
      });
      mockPrisma.user.update.mockResolvedValue({});

      await service.handleWebhookEvent(rawBody, signature);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          subscription: 'free',
          stripeSubscriptionId: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
        },
      });
    });

    it('should preserve pro status for lifetime pro user on subscription.deleted', async () => {
      const subscription = {
        id: 'sub_123',
        customer: 'cus_existing_123',
        items: { data: [] },
      };

      mockStripe.webhooks.constructEvent.mockReturnValue({
        type: 'customer.subscription.deleted',
        data: { object: subscription },
      });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        isLifetimePro: true,
        proExpiresAt: null,
      });
      mockPrisma.user.update.mockResolvedValue({});

      await service.handleWebhookEvent(rawBody, signature);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          stripeSubscriptionId: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
        },
      });
      // Should NOT set subscription to 'free'
      expect(mockPrisma.user.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ subscription: 'free' }),
        }),
      );
    });

    it('should preserve pro status for active voucher user on subscription.deleted', async () => {
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
      const subscription = {
        id: 'sub_123',
        customer: 'cus_existing_123',
        items: { data: [] },
      };

      mockStripe.webhooks.constructEvent.mockReturnValue({
        type: 'customer.subscription.deleted',
        data: { object: subscription },
      });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        isLifetimePro: false,
        proExpiresAt: futureDate,
      });
      mockPrisma.user.update.mockResolvedValue({});

      await service.handleWebhookEvent(rawBody, signature);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          stripeSubscriptionId: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
        },
      });
      // Should NOT set subscription to 'free'
      expect(mockPrisma.user.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ subscription: 'free' }),
        }),
      );
    });

    it('should throw BadRequestException for invalid webhook signature', async () => {
      mockStripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      await expect(
        service.handleWebhookEvent(rawBody, signature),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.handleWebhookEvent(rawBody, signature),
      ).rejects.toThrow('Invalid webhook signature');
    });

    it('should throw BadRequestException when webhook secret is not configured', async () => {
      // Use mockImplementation to override the return value for webhook secret
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'STRIPE_WEBHOOK_SECRET') return undefined;
        if (key === 'STRIPE_SECRET_KEY') return 'sk_test_123';
        if (key === 'STRIPE_PRO_PRICE_ID') return 'price_env_123';
        return undefined;
      });

      await expect(
        service.handleWebhookEvent(rawBody, signature),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.handleWebhookEvent(rawBody, signature),
      ).rejects.toThrow('Webhook secret not configured');
    });
  });
});
