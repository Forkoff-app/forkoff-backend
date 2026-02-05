import { IsString, IsOptional, IsUUID, MaxLength } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsString()
  @MaxLength(500)
  path: string;

  @IsUUID()
  deviceId: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  language?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  framework?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;
}
