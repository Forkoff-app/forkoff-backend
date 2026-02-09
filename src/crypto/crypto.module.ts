import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { CryptoController } from './crypto.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [CryptoService],
  controllers: [CryptoController],
  exports: [CryptoService],
})
export class CryptoModule {}
