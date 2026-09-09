import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GatewayLoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

export class GatewaySignupDto {
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  inviteCode: string;
}
