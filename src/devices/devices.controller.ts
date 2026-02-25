import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Query,
  Logger,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DevicesService } from './devices.service';
import { truncateId } from '../logging/sanitize';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User, DeviceStatus } from '@prisma/client';
import {
  CreateDeviceDto,
  UpdateDeviceDto,
  PairDeviceDto,
  RegisterDeviceDto,
} from './dto';

@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  private readonly logger = new Logger(DevicesController.name);

  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Get all devices for the authenticated user' })
  @ApiResponse({ status: 200, description: 'Returns list of user devices' })
  async findAll(@CurrentUser() user: User) {
    return this.devicesService.findAll(user.id);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Get a single device by ID' })
  @ApiParam({ name: 'id', description: 'Device UUID' })
  @ApiResponse({ status: 200, description: 'Returns the device' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.devicesService.findOne(user.id, id);
  }

  @Get(':id/public')
  @ApiOperation({ summary: 'Get device pairing status (public, for CLI polling)' })
  @ApiParam({ name: 'id', description: 'Device UUID' })
  @ApiResponse({ status: 200, description: 'Returns device pairing status' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async getPublicStatus(@Param('id') id: string) {
    return this.devicesService.getPublicStatus(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Create a new device directly' })
  @ApiResponse({ status: 201, description: 'Device created successfully' })
  async create(@CurrentUser() user: User, @Body() data: CreateDeviceDto) {
    return this.devicesService.create(user.id, data);
  }

  @Post('register')
  @Throttle({ short: { limit: 3, ttl: 1000 }, medium: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Register a device and get a pairing code (called from CLI)' })
  @ApiResponse({ status: 201, description: 'Returns pairing code and expiry time' })
  async register(@Body() data: RegisterDeviceDto) {
    return this.devicesService.createPairingCode(data);
  }

  @Post('pair')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Pair a device using a pairing code (called from mobile)' })
  @ApiResponse({ status: 200, description: 'Device paired successfully' })
  @ApiResponse({ status: 404, description: 'Invalid or expired pairing code' })
  async pair(
    @CurrentUser() user: User,
    @Body() data: PairDeviceDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`[PAIR] Pairing request received`);
    this.logger.log(`[PAIR] Auth header present: ${!!authHeader}`);
    this.logger.log(`[PAIR] Auth header: ${authHeader ? '[present]' : '[missing]'}`);
    this.logger.log(`[PAIR] User from JWT: ${truncateId(user?.id)}`);
    this.logger.log(`[PAIR] Pairing code: [redacted]`);
    return this.devicesService.pairDevice(user.id, data.pairingCode);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Update a device' })
  @ApiParam({ name: 'id', description: 'Device UUID' })
  @ApiResponse({ status: 200, description: 'Device updated successfully' })
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() data: UpdateDeviceDto,
  ) {
    return this.devicesService.update(user.id, id, data);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Remove/unpair a device' })
  @ApiParam({ name: 'id', description: 'Device UUID' })
  @ApiResponse({ status: 200, description: 'Device removed successfully' })
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    await this.devicesService.remove(user.id, id);
    return { success: true };
  }

  @Post(':id/refresh')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Refresh device status' })
  @ApiParam({ name: 'id', description: 'Device UUID' })
  @ApiResponse({ status: 200, description: 'Device status refreshed' })
  async refresh(@CurrentUser() user: User, @Param('id') id: string) {
    return this.devicesService.refresh(user.id, id);
  }

  @Get('status/:status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Get devices by status' })
  @ApiParam({ name: 'status', enum: ['ONLINE', 'OFFLINE', 'SYNCING'] })
  @ApiResponse({ status: 200, description: 'Returns devices with specified status' })
  async findByStatus(
    @CurrentUser() user: User,
    @Param('status') status: DeviceStatus,
  ) {
    return this.devicesService.findByStatus(user.id, status);
  }

  @Post(':id/tools')
  @Throttle({ short: { limit: 5, ttl: 1000 }, medium: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: 'Report connected tools from CLI' })
  @ApiParam({ name: 'id', description: 'Device UUID' })
  @ApiResponse({ status: 200, description: 'Tools updated successfully' })
  async reportTools(
    @Param('id') id: string,
    @Body() data: { tools: Array<{ type: string; name: string; version: string | null }> },
  ) {
    return this.devicesService.updateConnectedTools(id, data.tools);
  }
}
