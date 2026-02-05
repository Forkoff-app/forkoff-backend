import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

// Store GitHub token (received from Supabase OAuth)
export class StoreGithubTokenDto {
  @IsString()
  @MaxLength(500)
  accessToken: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  refreshToken?: string;
}

// Create repository
export class CreateRepoDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  @IsOptional()
  @IsBoolean()
  autoInit?: boolean;
}

// Clone repository to device
export class CloneRepoDto {
  @IsString()
  @MaxLength(100)
  deviceId: string;

  @IsString()
  @MaxLength(200)
  repoFullName: string; // e.g., "owner/repo"

  @IsString()
  @MaxLength(500)
  destinationPath: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  branch?: string;
}
