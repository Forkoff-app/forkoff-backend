import { IsString, IsOptional, MaxLength } from 'class-validator';

export class PairDeviceDto {
  @IsString()
  @MaxLength(20)
  pairingCode: string;
}

export class RegisterDeviceDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsString()
  @MaxLength(50)
  type: string;

  @IsString()
  @MaxLength(50)
  platform: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  hostname?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  osVersion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  machineId?: string;
}
