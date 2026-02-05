import {
  IsString,
  IsEnum,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { DeviceType, Platform } from '@prisma/client';

export class CreateDeviceDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsEnum(DeviceType)
  type: DeviceType;

  @IsEnum(Platform)
  platform: Platform;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  hostname?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  osVersion?: string;
}
