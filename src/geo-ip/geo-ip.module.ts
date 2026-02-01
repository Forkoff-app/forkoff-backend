import { Module } from '@nestjs/common';
import { GeoIpService } from './geo-ip.service';

@Module({
  providers: [GeoIpService],
  exports: [GeoIpService],
})
export class GeoIpModule {}
