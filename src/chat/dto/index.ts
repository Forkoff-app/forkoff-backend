import { IsString, IsEnum, IsOptional, IsUUID, MaxLength } from 'class-validator';
import { ToolType, MessageRole, ApprovalType, ApprovalStatus } from '@prisma/client';

// Create Chat Session
export class CreateChatSessionDto {
  @IsUUID()
  projectId: string;

  @IsEnum(ToolType)
  toolType: ToolType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

// Update Chat Session
export class UpdateChatSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

// Create Chat Message
export class CreateMessageDto {
  @IsEnum(MessageRole)
  role: MessageRole;

  @IsString()
  @MaxLength(50000)
  content: string;
}

// Create Approval Request
export class CreateApprovalRequestDto {
  @IsEnum(ApprovalType)
  type: ApprovalType;

  @IsString()
  @MaxLength(2000)
  description: string;

  changes: any;
}

// Respond to Approval Request
export class RespondApprovalDto {
  @IsEnum(ApprovalStatus)
  status: ApprovalStatus;
}
