import { IsString, IsOptional, IsUUID } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  name: string;

  @IsString()
  path: string;

  @IsUUID()
  deviceId: string;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  framework?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
