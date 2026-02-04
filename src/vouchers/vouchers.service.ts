import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VoucherBenefitType } from '@prisma/client';
import {
  VoucherRedemptionResponseDto,
  VoucherValidationResponseDto,
  VoucherRedemptionHistoryDto,
  VoucherBenefitDto,
} from './dto';

@Injectable()
export class VouchersService {
  private readonly logger = new Logger(VouchersService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Validate a voucher code without redeeming it
   */
  async validateVoucher(
    userId: string,
    code: string,
  ): Promise<VoucherValidationResponseDto> {
    const normalizedCode = code.trim().toUpperCase();

    const voucher = await this.prisma.voucher.findUnique({
      where: { code: normalizedCode },
    });

    if (!voucher) {
      return {
        valid: false,
        message: 'Invalid voucher code',
      };
    }

    if (!voucher.isActive) {
      return {
        valid: false,
        message: 'This voucher is no longer active',
      };
    }

    const now = new Date();
    if (voucher.validFrom > now) {
      return {
        valid: false,
        message: 'This voucher is not yet valid',
      };
    }

    if (voucher.validUntil && voucher.validUntil < now) {
      return {
        valid: false,
        message: 'This voucher has expired',
      };
    }

    if (
      voucher.maxRedemptions !== null &&
      voucher.currentRedemptions >= voucher.maxRedemptions
    ) {
      return {
        valid: false,
        message: 'This voucher has reached its redemption limit',
      };
    }

    // Check if user already redeemed this voucher
    const existingRedemption = await this.prisma.voucherRedemption.findUnique({
      where: {
        voucherId_userId: {
          voucherId: voucher.id,
          userId,
        },
      },
    });

    if (existingRedemption) {
      return {
        valid: false,
        message: 'You have already redeemed this voucher',
      };
    }

    return {
      valid: true,
      message: 'Voucher is valid',
      benefit: this.buildBenefitDto(voucher.benefitType, voucher.benefitValue),
    };
  }

  /**
   * Redeem a voucher code
   */
  async redeemVoucher(
    userId: string,
    code: string,
  ): Promise<VoucherRedemptionResponseDto> {
    const normalizedCode = code.trim().toUpperCase();

    // Validate first
    const validation = await this.validateVoucher(userId, normalizedCode);
    if (!validation.valid) {
      return {
        success: false,
        message: validation.message,
      };
    }

    const voucher = await this.prisma.voucher.findUnique({
      where: { code: normalizedCode },
    });

    if (!voucher) {
      return {
        success: false,
        message: 'Invalid voucher code',
      };
    }

    // Calculate benefit expiry for FREE_MONTHS
    let benefitExpiresAt: Date | null = null;
    if (voucher.benefitType === 'FREE_MONTHS') {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { proExpiresAt: true },
      });

      // Start from current expiry or now
      const startDate =
        user?.proExpiresAt && user.proExpiresAt > new Date()
          ? user.proExpiresAt
          : new Date();

      benefitExpiresAt = new Date(startDate);
      benefitExpiresAt.setMonth(
        benefitExpiresAt.getMonth() + voucher.benefitValue,
      );
    }

    // Transaction: create redemption, increment count, update user
    const result = await this.prisma.$transaction(async (tx) => {
      // Create redemption record
      const redemption = await tx.voucherRedemption.create({
        data: {
          voucherId: voucher.id,
          userId,
          benefitType: voucher.benefitType,
          benefitValue: voucher.benefitValue,
          benefitExpiresAt,
        },
      });

      // Increment voucher redemption count
      await tx.voucher.update({
        where: { id: voucher.id },
        data: {
          currentRedemptions: { increment: 1 },
        },
      });

      // Update user based on benefit type
      if (voucher.benefitType === 'LIFETIME_PRO') {
        await tx.user.update({
          where: { id: userId },
          data: {
            isLifetimePro: true,
            subscription: 'pro',
          },
        });
      } else if (voucher.benefitType === 'FREE_MONTHS') {
        await tx.user.update({
          where: { id: userId },
          data: {
            proExpiresAt: benefitExpiresAt,
            subscription: 'pro',
          },
        });
      }

      return redemption;
    });

    this.logger.log(
      `User ${userId} redeemed voucher ${normalizedCode} (${voucher.benefitType})`,
    );

    return {
      success: true,
      message: this.getSuccessMessage(voucher.benefitType, voucher.benefitValue),
      benefit: {
        ...this.buildBenefitDto(voucher.benefitType, voucher.benefitValue),
        expiresAt: benefitExpiresAt?.toISOString(),
      },
    };
  }

  /**
   * Get user's voucher redemption history
   */
  async getRedemptionHistory(
    userId: string,
  ): Promise<VoucherRedemptionHistoryDto[]> {
    const redemptions = await this.prisma.voucherRedemption.findMany({
      where: { userId },
      include: {
        voucher: {
          select: {
            code: true,
            campaignName: true,
          },
        },
      },
      orderBy: { redeemedAt: 'desc' },
    });

    return redemptions.map((r) => ({
      id: r.id,
      code: r.voucher.code,
      benefitType: r.benefitType,
      benefitValue: r.benefitValue,
      benefitExpiresAt: r.benefitExpiresAt?.toISOString(),
      redeemedAt: r.redeemedAt.toISOString(),
      campaignName: r.voucher.campaignName || undefined,
    }));
  }

  /**
   * Build benefit DTO from voucher data
   */
  private buildBenefitDto(
    benefitType: VoucherBenefitType,
    benefitValue: number,
  ): VoucherBenefitDto {
    switch (benefitType) {
      case 'LIFETIME_PRO':
        return {
          type: benefitType,
          value: 0,
          description: 'Lifetime PRO access',
        };
      case 'FREE_MONTHS':
        return {
          type: benefitType,
          value: benefitValue,
          description: `${benefitValue} month${benefitValue > 1 ? 's' : ''} of PRO access`,
        };
      case 'DISCOUNT_PERCENT':
        return {
          type: benefitType,
          value: benefitValue,
          description: `${benefitValue}% discount on PRO subscription`,
        };
      default:
        return {
          type: benefitType,
          value: benefitValue,
          description: 'Special benefit',
        };
    }
  }

  /**
   * Generate success message based on benefit type
   */
  private getSuccessMessage(
    benefitType: VoucherBenefitType,
    benefitValue: number,
  ): string {
    switch (benefitType) {
      case 'LIFETIME_PRO':
        return 'Congratulations! You now have lifetime PRO access!';
      case 'FREE_MONTHS':
        return `Congratulations! You now have ${benefitValue} month${benefitValue > 1 ? 's' : ''} of PRO access!`;
      case 'DISCOUNT_PERCENT':
        return `Your ${benefitValue}% discount has been applied!`;
      default:
        return 'Voucher redeemed successfully!';
    }
  }
}
