import {
  IsString,
  IsEnum,
  IsOptional,
} from 'class-validator';
import { DeviceType, Platform } from '@prisma/client';

export class CreateDeviceDto {
  @IsString()
  name: string;

  @IsEnum(DeviceType)
  type: DeviceType;

  @IsEnum(Platform)
  platform: Platform;

  @IsString()
  @IsOptional()
  hostname?: string;

  @IsString()
  @IsOptional()
  osVersion?: string;
}
