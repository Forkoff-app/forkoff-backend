import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { VouchersService } from './vouchers.service';
import {
  RedeemVoucherDto,
  VoucherRedemptionResponseDto,
  VoucherValidationResponseDto,
  VoucherRedemptionHistoryDto,
} from './dto';

@ApiTags('vouchers')
@ApiBearerAuth('supabase-auth')
@Controller('vouchers')
@UseGuards(JwtAuthGuard)
export class VouchersController {
  constructor(private readonly vouchersService: VouchersService) {}

  @Post('redeem')
  @ApiOperation({ summary: 'Redeem a voucher code' })
  @ApiResponse({ status: 200, type: VoucherRedemptionResponseDto })
  async redeemVoucher(
    @CurrentUser() user: User,
    @Body() dto: RedeemVoucherDto,
  ): Promise<VoucherRedemptionResponseDto> {
    return this.vouchersService.redeemVoucher(user.id, dto.code);
  }

  @Post('validate')
  @ApiOperation({ summary: 'Validate a voucher code without redeeming' })
  @ApiResponse({ status: 200, type: VoucherValidationResponseDto })
  async validateVoucher(
    @CurrentUser() user: User,
    @Body() dto: RedeemVoucherDto,
  ): Promise<VoucherValidationResponseDto> {
    return this.vouchersService.validateVoucher(user.id, dto.code);
  }

  @Get('my-redemptions')
  @ApiOperation({ summary: "Get user's voucher redemption history" })
  @ApiResponse({ status: 200, type: [VoucherRedemptionHistoryDto] })
  async getMyRedemptions(
    @CurrentUser() user: User,
  ): Promise<VoucherRedemptionHistoryDto[]> {
    return this.vouchersService.getRedemptionHistory(user.id);
  }
}
