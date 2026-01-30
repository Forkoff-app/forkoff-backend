import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('auth')
@ApiBearerAuth('supabase-auth')
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Returns the authenticated user profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: User) {
    return this.authService.getProfile(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 400, description: 'Username already taken' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() data: { name?: string; username?: string; avatarUrl?: string },
  ) {
    // Validate username if provided
    if (data.username) {
      const validation = this.authService.validateUsername(data.username);
      if (!validation.valid) {
        throw new BadRequestException(validation.error);
      }

      const available = await this.authService.isUsernameAvailable(data.username, user.id);
      if (!available) {
        throw new BadRequestException('Username is already taken');
      }
    }

    return this.authService.updateProfile(user.id, data);
  }

  @Get('username/check/:username')
  @ApiOperation({ summary: 'Check if username is available' })
  @ApiResponse({ status: 200, description: 'Returns availability status' })
  async checkUsername(
    @CurrentUser() user: User,
    @Param('username') username: string,
  ) {
    const validation = this.authService.validateUsername(username);
    if (!validation.valid) {
      return { available: false, error: validation.error };
    }

    const available = await this.authService.isUsernameAvailable(username, user.id);
    return { available, username };
  }

  @Delete('delete-account')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete current user account' })
  @ApiResponse({ status: 204, description: 'Account deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async deleteAccount(@CurrentUser() user: User) {
    await this.authService.deleteAccount(user.id);
  }
}
