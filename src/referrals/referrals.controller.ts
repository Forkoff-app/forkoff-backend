import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { ReferralsService } from './referrals.service';
import {
  ReferralCodeResponseDto,
  ReferralDto,
  ClaimRewardResponseDto,
  ApplyReferralResponseDto,
  ApplyReferralDto,
} from './dto';

@ApiTags('referrals')
@ApiBearerAuth('supabase-auth')
@Controller('referrals')
@UseGuards(JwtAuthGuard)
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  @Get('my-code')
  @ApiOperation({ summary: "Get or create user's referral code" })
  @ApiResponse({ status: 200, type: ReferralCodeResponseDto })
  async getMyCode(@CurrentUser() user: User): Promise<ReferralCodeResponseDto> {
    return this.referralsService.getOrCreateReferralCode(user.id);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get referral statistics' })
  @ApiResponse({ status: 200, type: ReferralCodeResponseDto })
  async getStats(@CurrentUser() user: User): Promise<ReferralCodeResponseDto> {
    return this.referralsService.getStats(user.id);
  }

  @Get('list')
  @ApiOperation({ summary: 'Get list of referrals' })
  @ApiResponse({ status: 200, type: [ReferralDto] })
  async getReferrals(@CurrentUser() user: User): Promise<ReferralDto[]> {
    return this.referralsService.getReferrals(user.id);
  }

  @Post('claim-reward')
  @ApiOperation({ summary: 'Claim earned referral reward months' })
  @ApiResponse({ status: 200, type: ClaimRewardResponseDto })
  async claimReward(
    @CurrentUser() user: User,
  ): Promise<ClaimRewardResponseDto> {
    return this.referralsService.claimReward(user.id);
  }

  @Post('apply')
  @ApiOperation({ summary: 'Apply a referral code (during signup)' })
  @ApiResponse({ status: 200, type: ApplyReferralResponseDto })
  async applyReferralCode(
    @CurrentUser() user: User,
    @Body() dto: ApplyReferralDto,
  ): Promise<ApplyReferralResponseDto> {
    return this.referralsService.applyReferralCode(user.id, dto.code);
  }
}
