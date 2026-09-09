import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { GatewayAuthService } from './gateway-auth.service';
import { GatewayLoginDto, GatewaySignupDto } from './dto/gateway-auth.dto';

@Controller('gateway')
export class GatewayAuthController {
  constructor(private auth: GatewayAuthService) {}

  private assertEnabled(): void {
    if (!this.auth.isEnabled()) {
      throw new NotFoundException();
    }
  }

  @Post('auth/login')
  @Throttle({ short: { limit: 2, ttl: 1000 }, medium: { limit: 5, ttl: 60000 }, long: { limit: 20, ttl: 3600000 } })
  async login(@Body() dto: GatewayLoginDto) {
    this.assertEnabled();
    return this.auth.login(dto.username, dto.password, dto.label);
  }

  @Post('auth/signup')
  @Throttle({ short: { limit: 1, ttl: 1000 }, medium: { limit: 3, ttl: 60000 }, long: { limit: 10, ttl: 3600000 } })
  async signup(@Body() dto: GatewaySignupDto) {
    this.assertEnabled();
    return this.auth.signup(dto.username, dto.password, dto.inviteCode);
  }

  @Get('health')
  @SkipThrottle()
  health() {
    return { status: 'ok', gateway: this.auth.isEnabled() };
  }
}
