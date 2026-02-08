import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      this.logger.warn('STRIPE_SECRET_KEY not configured — Stripe features disabled');
    }
    this.stripe = new Stripe(secretKey || '', {
      apiVersion: '2026-01-28.clover',
    });
  }

  /**
   * Get or create a Stripe customer for the given user
   */
  async getOrCreateStripeCustomer(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, stripeCustomerId: true },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const customer = await this.stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { userId: user.id },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customer.id },
    });

    this.logger.log(`Created Stripe customer ${customer.id} for user ${userId}`);
    return customer.id;
  }

  /**
   * Create a Stripe Checkout Session for subscription
   */
  async createCheckoutSession(
    userId: string,
    priceId: string,
  ): Promise<{ url: string }> {
    const allowedPriceIds = [
      this.configService.get<string>('STRIPE_PRO_PRICE_ID'),
    ].filter(Boolean);

    if (!allowedPriceIds.includes(priceId)) {
      throw new BadRequestException('Invalid price ID');
    }

    const customerId = await this.getOrCreateStripeCustomer(userId);

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://forkoff.app/checkout-success',
      cancel_url: 'https://forkoff.app/checkout-cancelled',
      subscription_data: {
        metadata: { userId },
      },
      metadata: { userId },
    });

    if (!session.url) {
      throw new BadRequestException('Failed to create checkout session');
    }

    return { url: session.url };
  }

  /**
   * Create a Stripe Customer Portal session
   */
  async createPortalSession(userId: string): Promise<{ url: string }> {
    const customerId = await this.getOrCreateStripeCustomer(userId);

    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'forkoff://settings/subscription',
    });

    return { url: session.url };
  }

  /**
   * Handle incoming Stripe webhook events
   */
  async handleWebhookEvent(rawBody: Buffer, signature: string): Promise<void> {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new BadRequestException('Webhook secret not configured');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    this.logger.log(`Webhook received: ${event.type}`);

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpsert(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_failed':
        this.logger.warn(
          `Payment failed for invoice ${(event.data.object as Stripe.Invoice).id}`,
        );
        break;

      case 'checkout.session.completed':
        this.logger.log(
          `Checkout completed: ${(event.data.object as Stripe.Checkout.Session).id}`,
        );
        break;

      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }
  }

  /**
   * Map a Stripe price ID to a subscription tier
   */
  private mapPriceToTier(priceId: string): 'pro' {
    const proPriceId = this.configService.get<string>('STRIPE_PRO_PRICE_ID');

    if (priceId !== proPriceId) {
      this.logger.warn(`Unknown price ID: ${priceId}, defaulting to pro`);
    }

    return 'pro';
  }

  /**
   * Handle subscription created or updated
   */
  private async handleSubscriptionUpsert(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
    });

    if (!user) {
      this.logger.warn(`No user found for Stripe customer ${customerId}`);
      return;
    }

    const priceId = subscription.items.data[0]?.price?.id;
    if (!priceId) {
      this.logger.warn(`No price ID found in subscription ${subscription.id}`);
      return;
    }

    const tier = this.mapPriceToTier(priceId);
    const periodEnd = subscription.items.data[0]?.current_period_end;
    const currentPeriodEnd = periodEnd ? new Date(periodEnd * 1000) : null;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscription: tier,
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId,
        stripeCurrentPeriodEnd: currentPeriodEnd,
      },
    });

    this.logger.log(
      `User ${user.id} subscription updated to ${tier} (expires ${currentPeriodEnd?.toISOString() ?? 'unknown'})`,
    );
  }

  /**
   * Handle subscription deleted (cancelled)
   */
  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
      select: {
        id: true,
        isLifetimePro: true,
        proExpiresAt: true,
      },
    });

    if (!user) {
      this.logger.warn(`No user found for Stripe customer ${customerId}`);
      return;
    }

    // Don't downgrade if user has lifetime PRO or active voucher/referral PRO
    if (user.isLifetimePro) {
      this.logger.log(`User ${user.id} has lifetime PRO — keeping PRO after Stripe cancel`);
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          stripeSubscriptionId: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
        },
      });
      return;
    }

    if (user.proExpiresAt && user.proExpiresAt > new Date()) {
      this.logger.log(
        `User ${user.id} has active voucher/referral PRO until ${user.proExpiresAt.toISOString()} — keeping PRO after Stripe cancel`,
      );
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          stripeSubscriptionId: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
        },
      });
      return;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscription: 'free',
        stripeSubscriptionId: null,
        stripePriceId: null,
        stripeCurrentPeriodEnd: null,
      },
    });

    this.logger.log(`User ${user.id} downgraded to free after Stripe subscription cancelled`);
  }
}
