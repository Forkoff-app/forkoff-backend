import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VoucherBenefitType } from '@prisma/client';

export class VoucherBenefitDto {
  @ApiProperty({ description: 'Type of benefit', enum: ['FREE_MONTHS', 'LIFETIME_PRO', 'DISCOUNT_PERCENT'] })
  type: VoucherBenefitType;

  @ApiProperty({ description: 'Benefit value (months, percentage, etc.)' })
  value: number;

  @ApiPropertyOptional({ description: 'When the benefit expires (ISO date)' })
  expiresAt?: string;

  @ApiProperty({ description: 'Human-readable description of the benefit' })
  description: string;
}

export class VoucherRedemptionResponseDto {
  @ApiProperty({ description: 'Whether the redemption was successful' })
  success: boolean;

  @ApiProperty({ description: 'Message describing the result' })
  message: string;

  @ApiPropertyOptional({ description: 'Benefit details if successful', type: VoucherBenefitDto })
  benefit?: VoucherBenefitDto;
}

export class VoucherValidationResponseDto {
  @ApiProperty({ description: 'Whether the voucher is valid' })
  valid: boolean;

  @ApiProperty({ description: 'Message describing the validation result' })
  message: string;

  @ApiPropertyOptional({ description: 'Benefit details if valid', type: VoucherBenefitDto })
  benefit?: VoucherBenefitDto;
}

export class VoucherRedemptionHistoryDto {
  @ApiProperty({ description: 'Redemption ID' })
  id: string;

  @ApiProperty({ description: 'Voucher code' })
  code: string;

  @ApiProperty({ description: 'Benefit type' })
  benefitType: VoucherBenefitType;

  @ApiProperty({ description: 'Benefit value' })
  benefitValue: number;

  @ApiPropertyOptional({ description: 'When the benefit expires' })
  benefitExpiresAt?: string;

  @ApiProperty({ description: 'When the voucher was redeemed' })
  redeemedAt: string;

  @ApiPropertyOptional({ description: 'Campaign name if applicable' })
  campaignName?: string;
}
