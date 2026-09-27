import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { GatewayAuthController } from './gateway-auth.controller';
import { GatewayAuthService } from './gateway-auth.service';
import { TokenCryptoService } from './token-crypto.service';

@Module({
  imports: [PrismaModule],
  controllers: [GatewayAuthController],
  providers: [GatewayAuthService, TokenCryptoService],
  exports: [GatewayAuthService],
})
export class GatewayModule {}
