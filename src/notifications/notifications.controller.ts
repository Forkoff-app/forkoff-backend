import {
  Controller,
  Post,
  Delete,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
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
  constructor(private notificationsService: NotificationsService) {}

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
