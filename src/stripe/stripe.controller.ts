import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  Headers,
  RawBodyRequest,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { StripeService } from './stripe.service';
import { CreateCheckoutDto, CheckoutResponseDto, PortalResponseDto } from './dto';

@ApiTags('stripe')
@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('checkout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  async createCheckout(
    @CurrentUser() user: User,
    @Body() dto: CreateCheckoutDto,
  ): Promise<CheckoutResponseDto> {
    return this.stripeService.createCheckoutSession(user.id, dto.priceId);
  }

  @Post('portal')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  async createPortal(@CurrentUser() user: User): Promise<PortalResponseDto> {
    return this.stripeService.createPortalSession(user.id);
  }

  @Post('webhook')
  @SkipThrottle()
  @HttpCode(200)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: true }> {
    await this.stripeService.handleWebhookEvent(req.rawBody!, signature);
    return { received: true };
  }
}
