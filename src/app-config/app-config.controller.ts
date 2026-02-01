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
import { AppConfigService, VersionConfig } from './app-config.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Update version configuration (admin only)' })
  @ApiResponse({ status: 200, description: 'Version config updated' })
  async setVersionConfig(
    @Body() config: Partial<VersionConfig>,
  ): Promise<VersionConfig> {
    // TODO: Add admin role check
    return this.appConfigService.setVersionConfig(config);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @ApiOperation({ summary: 'Get all app configurations (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns all configs' })
  async getAllConfigs(): Promise<Record<string, any>> {
    // TODO: Add admin role check
    return this.appConfigService.getAllConfigs();
  }
}
