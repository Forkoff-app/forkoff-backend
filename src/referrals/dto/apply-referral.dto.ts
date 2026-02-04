import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';

export class ApplyReferralDto {
  @ApiProperty({ description: 'Referral code to apply', example: 'ABC123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(20)
  code: string;
}
