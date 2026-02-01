import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LimitType } from '../constants';

export class LimitCheckResponseDto {
  @ApiProperty({ description: 'Whether the action is allowed' })
  allowed: boolean;

  @ApiPropertyOptional({ description: 'Type of limit being checked' })
  limitType?: LimitType;

  @ApiPropertyOptional({ description: 'Current usage count' })
  currentUsage?: number;

  @ApiPropertyOptional({ description: 'Maximum limit' })
  limit?: number;

  @ApiPropertyOptional({ description: 'When the limit resets (ISO date)' })
  resetAt?: string;
}
