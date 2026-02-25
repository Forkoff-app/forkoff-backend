import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  Device,
  DeviceStatus,
  DeviceType,
  Platform,
  Prisma,
  ToolType,
  ToolStatus,
} from '@prisma/client';
import { CreateDeviceDto, UpdateDeviceDto, RegisterDeviceDto } from './dto';
import { randomBytes } from 'crypto';

@Injectable()
export class DevicesService {
  private readonly pairingCodeExpiryMinutes: number;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.pairingCodeExpiryMinutes =
      this.configService.get<number>('PAIRING_CODE_EXPIRY_MINUTES') || 10;
  }

  // Generate a unique pairing code
  private generatePairingCode(): string {
    return randomBytes(4).toString('hex').toUpperCase(); // 8 character code
  }

  // Get all devices for a user
  async findAll(userId: string): Promise<Device[]> {
    return this.prisma.device.findMany({
      where: { userId },
      include: {
        connectedTools: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Get a single device
  async findOne(userId: string, deviceId: string): Promise<Device> {
    const device = await this.prisma.device.findFirst({
      where: {
        id: deviceId,
        userId,
      },
      include: {
        connectedTools: true,
      },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return device;
  }

  // Create a new device (direct creation, not through pairing)
  async create(userId: string, data: CreateDeviceDto): Promise<Device> {
    return this.prisma.device.create({
      data: {
        ...data,
        userId,
        status: DeviceStatus.OFFLINE,
      },
      include: {
        connectedTools: true,
      },
    });
  }

  // Map OS platform strings to Platform enum
  private mapPlatform(platform: string): Platform {
    const platformMap: Record<string, Platform> = {
      win32: Platform.WINDOWS,
      darwin: Platform.MACOS,
      linux: Platform.LINUX,
      windows: Platform.WINDOWS,
      macos: Platform.MACOS,
    };
    const normalized = platform.toLowerCase();
    return platformMap[normalized] || Platform.LINUX;
  }

  // Map device type strings to DeviceType enum
  private mapDeviceType(type: string): DeviceType {
    const typeMap: Record<string, DeviceType> = {
      desktop: DeviceType.DESKTOP,
      laptop: DeviceType.LAPTOP,
      server: DeviceType.SERVER,
    };
    const normalized = type.toLowerCase();
    return typeMap[normalized] || DeviceType.DESKTOP;
  }

  // Generate a pairing code for a new device registration
  // This is called from the CLI tool on the computer
  async createPairingCode(data: RegisterDeviceDto): Promise<{
    pairingCode: string;
    expiresAt: Date;
    device: {
      id: string;
      name: string;
      status: string;
    };
  }> {
    const pairingCode = this.generatePairingCode();
    const expiresAt = new Date(
      Date.now() + this.pairingCodeExpiryMinutes * 60 * 1000,
    );

    // Map device type and platform
    const type = this.mapDeviceType(data.type);
    const platform = this.mapPlatform(data.platform);

    // Create a pending device with the pairing code (userId is null until paired)
    const device = await this.prisma.device.create({
      data: {
        name: data.name,
        type,
        platform,
        hostname: data.hostname,
        pairingCode,
        pairingExpires: expiresAt,
        status: DeviceStatus.OFFLINE,
        // userId is null for unpaired devices
      },
    });

    return {
      pairingCode,
      expiresAt,
      device: {
        id: device.id,
        name: device.name,
        status: device.status,
      },
    };
  }

  // Pair a device using a pairing code (called from mobile app)
  async pairDevice(userId: string, pairingCode: string): Promise<Device> {
    // Find the device with this pairing code
    const device = await this.prisma.device.findFirst({
      where: {
        pairingCode: pairingCode.toUpperCase(),
        pairingExpires: {
          gt: new Date(), // Not expired
        },
      },
    });

    if (!device) {
      throw new BadRequestException('Invalid or expired pairing code');
    }

    // Check if device is already paired to this user
    if (device.userId === userId) {
      throw new BadRequestException('Device is already paired to your account');
    }

    // Check if device is already paired to another user
    if (device.userId !== null) {
      throw new ForbiddenException('Device is already paired to another user');
    }

    // Update the device with the user ID and clear pairing info
    const pairedDevice = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        userId,
        pairingCode: null,
        pairingExpires: null,
        status: DeviceStatus.ONLINE,
        lastSeenAt: new Date(),
      },
      include: {
        connectedTools: true,
      },
    });

    return pairedDevice;
  }

  // Update device
  async update(
    userId: string,
    deviceId: string,
    data: UpdateDeviceDto,
  ): Promise<Device> {
    // Verify ownership
    await this.findOne(userId, deviceId);

    return this.prisma.device.update({
      where: { id: deviceId },
      data,
      include: {
        connectedTools: true,
      },
    });
  }

  // Update device status (called from CLI/WebSocket)
  async updateStatus(
    deviceId: string,
    status: DeviceStatus,
  ): Promise<Device> {
    return this.prisma.device.update({
      where: { id: deviceId },
      data: {
        status,
        lastSeenAt: new Date(),
      },
      include: {
        connectedTools: true,
      },
    });
  }

  // Auto-register a device that doesn't exist in the database
  // This handles the case where a device was deleted but CLI still has its ID
  async autoRegister(
    deviceId: string,
    userId: string,
    options?: {
      name?: string;
      type?: string;
      platform?: string;
      hostname?: string;
    },
  ): Promise<Device> {
    const type = options?.type ? this.mapDeviceType(options.type) : DeviceType.DESKTOP;
    const platform = options?.platform ? this.mapPlatform(options.platform) : Platform.WINDOWS;

    return this.prisma.device.create({
      data: {
        id: deviceId,
        name: options?.name || 'CLI Device',
        type,
        platform,
        hostname: options?.hostname,
        userId,
        status: DeviceStatus.ONLINE,
        lastSeenAt: new Date(),
      },
      include: {
        connectedTools: true,
      },
    });
  }

  // Check if a device exists
  async exists(deviceId: string): Promise<boolean> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true },
    });
    return device !== null;
  }

  // Delete/remove device
  async remove(userId: string, deviceId: string): Promise<void> {
    // Verify ownership
    await this.findOne(userId, deviceId);

    await this.prisma.device.delete({
      where: { id: deviceId },
    });
  }

  // Refresh device status (trigger a status check)
  async refresh(userId: string, deviceId: string): Promise<Device> {
    const device = await this.findOne(userId, deviceId);

    // In a real implementation, this would trigger a WebSocket ping to the device
    // For now, just return the current device state
    return device;
  }

  // Get devices by status
  async findByStatus(userId: string, status: DeviceStatus): Promise<Device[]> {
    return this.prisma.device.findMany({
      where: {
        userId,
        status,
      },
      include: {
        connectedTools: true,
      },
    });
  }

  // Get public device status (for CLI polling during pairing)
  async getPublicStatus(deviceId: string): Promise<{
    id: string;
    name: string;
    status: string;
    userId: string | null;
    isPaired: boolean;
  }> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return {
      id: device.id,
      name: device.name,
      status: device.status,
      userId: device.userId,
      isPaired: device.userId !== null,
    };
  }

  // Clean up expired pairing codes (can be called by a cron job)
  async cleanupExpiredPairingCodes(): Promise<number> {
    const result = await this.prisma.device.deleteMany({
      where: {
        userId: null,
        pairingExpires: {
          lt: new Date(),
        },
      },
    });

    return result.count;
  }

  // Map CLI tool type strings to ToolType enum
  // Note: CLAUDE_TERMINAL is consolidated into CLAUDE_CODE as they represent the same tool
  private mapToolType(type: string): ToolType | null {
    const typeMap: Record<string, ToolType> = {
      claude_code: ToolType.CLAUDE_CODE,
      'claude-code': ToolType.CLAUDE_CODE,
      claude_terminal: ToolType.CLAUDE_CODE, // Consolidated into CLAUDE_CODE
      'claude-terminal': ToolType.CLAUDE_CODE, // Consolidated into CLAUDE_CODE
      cursor: ToolType.CURSOR,
      copilot: ToolType.COPILOT,
      windsurf: ToolType.WINDSURF,
      continue: ToolType.CONTINUE,
    };
    const normalized = type.toLowerCase();
    return typeMap[normalized] || null;
  }

  // Map status string to ToolStatus enum
  private mapToolStatus(status: string): ToolStatus {
    const statusMap: Record<string, ToolStatus> = {
      active: ToolStatus.ACTIVE,
      inactive: ToolStatus.INACTIVE,
      error: ToolStatus.ERROR,
      ACTIVE: ToolStatus.ACTIVE,
      INACTIVE: ToolStatus.INACTIVE,
      ERROR: ToolStatus.ERROR,
    };
    return statusMap[status] || ToolStatus.INACTIVE;
  }

  // Update a specific tool's status on a device
  async updateToolStatus(
    deviceId: string,
    toolType: string,
    status: string,
  ): Promise<void> {
    const mappedToolType = this.mapToolType(toolType);
    if (!mappedToolType) {
      return; // Unknown tool type, skip
    }

    const mappedStatus = this.mapToolStatus(status);

    // Upsert the tool status
    await this.prisma.deviceTool.upsert({
      where: {
        deviceId_type: {
          deviceId,
          type: mappedToolType,
        },
      },
      update: {
        status: mappedStatus,
      },
      create: {
        deviceId,
        type: mappedToolType,
        name: toolType,
        status: mappedStatus,
      },
    });
  }

  // Update connected tools for a device (called from CLI)
  async updateConnectedTools(
    deviceId: string,
    tools: Array<{ type: string; name: string; version: string | null }>,
  ): Promise<Device> {
    // Verify device exists
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // Clean up legacy CLAUDE_TERMINAL entries (consolidated into CLAUDE_CODE)
    await this.prisma.deviceTool.deleteMany({
      where: {
        deviceId,
        type: ToolType.CLAUDE_TERMINAL,
      },
    });

    // Upsert each tool
    for (const tool of tools) {
      const toolType = this.mapToolType(tool.type);
      if (!toolType) {
        continue; // Skip unknown tool types
      }

      await this.prisma.deviceTool.upsert({
        where: {
          deviceId_type: {
            deviceId,
            type: toolType,
          },
        },
        update: {
          name: tool.name,
          version: tool.version,
          status: ToolStatus.ACTIVE,
        },
        create: {
          deviceId,
          type: toolType,
          name: tool.name,
          version: tool.version,
          status: ToolStatus.ACTIVE,
        },
      });
    }

    // Return updated device with tools (device exists since we checked above)
    const updatedDevice = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        connectedTools: true,
      },
    });

    return updatedDevice!;
  }
}
