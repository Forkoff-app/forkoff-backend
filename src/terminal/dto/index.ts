import { IsString, IsUUID, IsOptional, MaxLength } from 'class-validator';

// Create Terminal Session
export class CreateTerminalSessionDto {
  @IsUUID()
  deviceId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  workingDirectory?: string;
}

// Execute Command
export class ExecuteCommandDto {
  @IsString()
  @MaxLength(10000)
  command: string;
}
