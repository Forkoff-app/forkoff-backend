import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddToWaitlistDto {
  @ApiProperty({
    description: 'Email address to add to waitlist',
    example: 'user@example.com',
  })
  @IsEmail()
  email: string;
}
