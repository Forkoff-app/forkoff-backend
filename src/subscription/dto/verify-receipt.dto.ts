import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export class VerifyReceiptDto {
  @ApiProperty({ description: 'Base64-encoded App Store receipt or transaction receipt' })
  @IsString()
  @IsNotEmpty()
  receipt: string;

  @ApiProperty({ description: 'The product ID purchased (e.g. com.forkoff.pro.monthly)' })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ description: 'Platform: ios or android', enum: ['ios', 'android'] })
  @IsString()
  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';
}

export class VerifyReceiptResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ required: false })
  subscription?: string;

  @ApiProperty({ required: false })
  error?: string;
}
