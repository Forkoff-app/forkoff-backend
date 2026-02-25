import {
  Controller,
  Post,
  Delete,
  Body,
  UseGuards,
  Request,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';

interface RegisterTokenDto {
  token: string;
  platform: string; // 'ios' | 'android'
}

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    private notificationsService: NotificationsService,
    private configService: ConfigService,
  ) {}

  /**
   * Register a push notification token
   * POST /notifications/register
   */
  @Post('register')
  @UseGuards(SupabaseAuthGuard)
  async registerToken(
    @Request() req: AuthenticatedRequest,
    @Body() body: RegisterTokenDto,
  ) {
    await this.notificationsService.registerToken(
      req.user.id,
      body.token,
      body.platform,
    );
    return { success: true };
  }

  /**
   * Broadcast a push notification to all registered users
   * POST /notifications/broadcast
   */
  @Post('broadcast')
  async broadcast(
    @Request() req: any,
    @Body() body: { title: string; body: string; data?: Record<string, unknown> },
  ) {
    const adminKey = req.headers['x-admin-key'];
    const expectedKey = this.configService.get<string>('ADMIN_API_KEY');
    if (!expectedKey || adminKey !== expectedKey) {
      throw new UnauthorizedException('Invalid admin key');
    }

    const result = await this.notificationsService.broadcastToAll(
      body.title,
      body.body,
      body.data,
    );
    return { success: true, ...result };
  }

  /**
   * Unregister a push notification token
   * DELETE /notifications/unregister
   */
  @Delete('unregister')
  @UseGuards(SupabaseAuthGuard)
  async unregisterToken(
    @Request() req: AuthenticatedRequest,
    @Body() body: { token: string },
  ) {
    await this.notificationsService.unregisterToken(req.user.id, body.token);
    return { success: true };
  }
}
