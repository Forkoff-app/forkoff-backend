import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateProjectDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  name?: string;

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
