import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCheckoutDto {
  @ApiProperty({ description: 'Stripe Price ID for the subscription plan' })
  @IsString()
  @IsNotEmpty()
  priceId: string;
}
