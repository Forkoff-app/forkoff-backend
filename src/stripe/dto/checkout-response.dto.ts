import { ApiProperty } from '@nestjs/swagger';

export class CheckoutResponseDto {
  @ApiProperty({ description: 'Stripe Checkout Session URL' })
  url: string;
}
