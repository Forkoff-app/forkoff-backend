import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReferralStatsDto {
  @ApiProperty({ description: 'Total number of referrals' })
  totalReferrals: number;

  @ApiProperty({ description: 'Number of converted referrals (users who subscribed to PRO)' })
  successfulConversions: number;

  @ApiProperty({ description: 'Number of reward months available to claim' })
  rewardMonthsAvailable: number;

  @ApiProperty({ description: 'Progress towards next reward (0-2)' })
  nextRewardProgress: number;
}

export class ReferralCodeResponseDto {
  @ApiProperty({ description: "User's unique referral code" })
  referralCode: string;

  @ApiProperty({ description: 'Shareable referral URL' })
  shareUrl: string;

  @ApiProperty({ description: 'Referral statistics', type: ReferralStatsDto })
  stats: ReferralStatsDto;
}

export class ReferralDto {
  @ApiProperty({ description: 'Referral ID' })
  id: string;

  @ApiPropertyOptional({ description: 'Referred user email (masked)' })
  referredUserEmail?: string;

  @ApiProperty({ description: 'When the user signed up' })
  signedUpAt: string;

  @ApiProperty({ description: 'Whether the user converted to PRO' })
  isConverted: boolean;

  @ApiPropertyOptional({ description: 'When the user converted' })
  convertedAt?: string;
}

export class ClaimRewardResponseDto {
  @ApiProperty({ description: 'Whether the claim was successful' })
  success: boolean;

  @ApiProperty({ description: 'Message describing the result' })
  message: string;

  @ApiPropertyOptional({ description: 'Number of months claimed' })
  monthsClaimed?: number;

  @ApiPropertyOptional({ description: 'New PRO expiry date' })
  newExpiresAt?: string;
}

export class ApplyReferralResponseDto {
  @ApiProperty({ description: 'Whether the referral was applied' })
  success: boolean;

  @ApiProperty({ description: 'Message describing the result' })
  message: string;
}
