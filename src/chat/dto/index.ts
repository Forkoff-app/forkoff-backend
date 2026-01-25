import { IsString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ToolType, MessageRole, ApprovalType, ApprovalStatus } from '@prisma/client';

// Create Chat Session
export class CreateChatSessionDto {
  @IsUUID()
  projectId: string;

  @IsEnum(ToolType)
  toolType: ToolType;

  @IsOptional()
  @IsString()
  title?: string;
}

// Update Chat Session
export class UpdateChatSessionDto {
  @IsOptional()
  @IsString()
  title?: string;
}

// Create Chat Message
export class CreateMessageDto {
  @IsEnum(MessageRole)
  role: MessageRole;

  @IsString()
  content: string;
}

// Create Approval Request
export class CreateApprovalRequestDto {
  @IsEnum(ApprovalType)
  type: ApprovalType;

  @IsString()
  description: string;

  changes: any; // JSON array of code changes
}

// Respond to Approval Request
export class RespondApprovalDto {
  @IsEnum(ApprovalStatus)
  status: ApprovalStatus;
}
