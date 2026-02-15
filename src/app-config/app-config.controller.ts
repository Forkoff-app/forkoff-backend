import {
  Controller,
  Get,
  Put,
  Body,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AppConfigService, VersionConfig, SubscriptionPlansConfig } from './app-config.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';

@ApiTags('app-config')
@Controller('app-config')
export class AppConfigController {
  constructor(private appConfigService: AppConfigService) {}

  @Get('version')
  @ApiOperation({ summary: 'Get version configuration' })
  @ApiResponse({ status: 200, description: 'Returns version config' })
  async getVersionConfig(): Promise<VersionConfig> {
    return this.appConfigService.getVersionConfig();
  }

  @Put('version')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Update version configuration (admin only)' })
  @ApiResponse({ status: 200, description: 'Version config updated' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async setVersionConfig(
    @Body() config: Partial<VersionConfig>,
  ): Promise<VersionConfig> {
    return this.appConfigService.setVersionConfig(config);
  }

  @Get('plans')
  @ApiOperation({ summary: 'Get subscription plans configuration' })
  @ApiResponse({ status: 200, description: 'Returns subscription plans config' })
  async getSubscriptionPlans(): Promise<SubscriptionPlansConfig> {
    return this.appConfigService.getSubscriptionPlans();
  }

  @Put('plans')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Update subscription plans configuration (admin only)' })
  @ApiResponse({ status: 200, description: 'Plans config updated' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async setSubscriptionPlans(
    @Body() config: Partial<SubscriptionPlansConfig>,
  ): Promise<SubscriptionPlansConfig> {
    return this.appConfigService.setSubscriptionPlans(config);
  }

  @Get()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Get all app configurations (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns all configs' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async getAllConfigs(): Promise<Record<string, any>> {
    return this.appConfigService.getAllConfigs();
  }
}
