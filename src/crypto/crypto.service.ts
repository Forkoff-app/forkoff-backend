import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CryptoService {
  constructor(private prisma: PrismaService) {}

  /**
   * Store X25519 public key for a device
   */
  async storePublicKey(
    deviceId: string,
    publicKey: string,
    userId: string,
  ): Promise<{ success: boolean; keyVersion: number }> {
    // Validate Base64 format
    if (!this.isValidBase64(publicKey)) {
      throw new BadRequestException('Public key must be valid Base64');
    }

    // Validate key length (32 bytes for X25519)
    const decoded = Buffer.from(publicKey, 'base64');
    if (decoded.length !== 32) {
      throw new BadRequestException(
        'Public key must be 32 bytes when decoded',
      );
    }

    // Verify device exists and belongs to user
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, userId: true },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (device.userId !== userId) {
      throw new BadRequestException('You do not own this device');
    }

    // Store key and increment version
    const updated = await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        publicKeyX25519: publicKey,
        e2eeKeyVersion: { increment: 1 },
      },
      select: { e2eeKeyVersion: true },
    });

    return {
      success: true,
      keyVersion: updated.e2eeKeyVersion,
    };
  }

  /**
   * Retrieve X25519 public key for a device
   */
  async getPublicKey(
    deviceId: string,
  ): Promise<{ publicKey: string; keyVersion: number } | null> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        publicKeyX25519: true,
        e2eeKeyVersion: true,
      },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (!device.publicKeyX25519 || device.e2eeKeyVersion === 0) {
      return null;
    }

    return {
      publicKey: device.publicKeyX25519,
      keyVersion: device.e2eeKeyVersion,
    };
  }

  /**
   * Validate Base64 string
   */
  private isValidBase64(str: string): boolean {
    try {
      const decoded = Buffer.from(str, 'base64');
      return Buffer.from(decoded).toString('base64') === str;
    } catch {
      return false;
    }
  }
}
