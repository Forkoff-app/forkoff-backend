import { IsString, IsOptional, IsBoolean, IsUrl } from 'class-validator';

// Store GitHub token (received from Supabase OAuth)
export class StoreGithubTokenDto {
  @IsString()
  accessToken: string;

  @IsOptional()
  @IsString()
  refreshToken?: string;
}

// Create repository
export class CreateRepoDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
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
  deviceId: string;

  @IsString()
  repoFullName: string; // e.g., "owner/repo"

  @IsString()
  destinationPath: string;

  @IsOptional()
  @IsString()
  branch?: string;
}
