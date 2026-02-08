import { ApiProperty } from '@nestjs/swagger';

export class PortalResponseDto {
  @ApiProperty({ description: 'Stripe Customer Portal URL' })
  url: string;
}
