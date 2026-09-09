import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class TokenCryptoService {
  private key: Buffer | null = null;

  private getKey(): Buffer {
    if (this.key) return this.key;
    const raw = process.env.GATEWAY_TOKEN_ENC_KEY;
    if (!raw) {
      throw new Error('GATEWAY_TOKEN_ENC_KEY is not configured');
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('GATEWAY_TOKEN_ENC_KEY must decode to exactly 32 bytes');
    }
    this.key = key;
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1$${iv.toString('base64')}$${tag.toString('base64')}$${ct.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split('$');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Unrecognized encrypted token format');
    }
    const [, ivB64, tagB64, ctB64] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.getKey(),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
