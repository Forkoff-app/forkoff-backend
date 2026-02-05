import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateDeviceDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;
}
