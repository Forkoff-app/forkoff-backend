import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';

export class RedeemVoucherDto {
  @ApiProperty({ description: 'Voucher code to redeem', example: 'FORKOFF2024' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(50)
  code: string;
}
