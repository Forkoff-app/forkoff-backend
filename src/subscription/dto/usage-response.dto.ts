import { ApiProperty } from '@nestjs/swagger';

export class UsageResponseDto {
  @ApiProperty({ description: 'Number of messages used today' })
  messagesUsedToday: number;

  @ApiProperty({ description: 'When daily message limit resets (ISO date)' })
  messageLimitResetAt: string;

  @ApiProperty({ description: 'Number of sessions started this month' })
  sessionsUsedThisMonth: number;

  @ApiProperty({ description: 'Number of device re-pairs this month' })
  repairsUsedThisMonth: number;

  @ApiProperty({ description: 'When monthly limits reset (ISO date)' })
  monthlyLimitResetAt: string;

  @ApiProperty({ description: 'Current number of active projects' })
  activeProjectCount: number;

  @ApiProperty({ description: 'Current number of paired devices' })
  pairedDeviceCount: number;
}
