import { IsString, IsUUID, IsOptional } from 'class-validator';

// Create Terminal Session
export class CreateTerminalSessionDto {
  @IsUUID()
  deviceId: string;

  @IsOptional()
  @IsString()
  workingDirectory?: string;
}

// Execute Command
export class ExecuteCommandDto {
  @IsString()
  command: string;
}
