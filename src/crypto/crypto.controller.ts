import {
  Controller,
  Put,
  Get,
  Param,
  Body,
  UseGuards,
  Request,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CryptoService } from './crypto.service';
import { StorePublicKeyDto } from './dto/store-public-key.dto';

@Controller('api/devices')
@UseGuards(JwtAuthGuard)
export class CryptoController {
  constructor(private cryptoService: CryptoService) {}

  /**
   * Store X25519 public key for a device
   * PUT /api/devices/:id/public-key
   */
  @Put(':id/public-key')
  async storePublicKey(
    @Param('id') deviceId: string,
    @Body() dto: StorePublicKeyDto,
    @Request() req: any,
  ) {
    if (!req.user?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    return this.cryptoService.storePublicKey(
      deviceId,
      dto.publicKey,
      req.user.id,
    );
  }

  /**
   * Get X25519 public key for a device
   * GET /api/devices/:id/public-key
   */
  @Get(':id/public-key')
  async getPublicKey(@Param('id') deviceId: string, @Request() req: any) {
    if (!req.user?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    const result = await this.cryptoService.getPublicKey(deviceId);

    if (!result) {
      throw new NotFoundException('Public key not found for this device');
    }

    return result;
  }
}
