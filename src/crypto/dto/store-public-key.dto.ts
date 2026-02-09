import { IsString, IsNotEmpty } from 'class-validator';

export class StorePublicKeyDto {
  @IsString()
  @IsNotEmpty()
  publicKey: string;
}
