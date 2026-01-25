import { IsString, IsOptional } from 'class-validator';

export class PairDeviceDto {
  @IsString()
  pairingCode: string;
}

export class RegisterDeviceDto {
  @IsString()
  name: string;

  @IsString()
  type: string; // Will be validated in service

  @IsString()
  platform: string; // Will be validated in service

  @IsString()
  @IsOptional()
  hostname?: string;

  @IsString()
  @IsOptional()
  osVersion?: string;

  @IsString()
  @IsOptional()
  machineId?: string;
}
