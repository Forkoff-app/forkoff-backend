import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCryptoService } from './token-crypto.service';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_CACHE_TTL_MS = 60_000;

export interface ResolvedKey {
  oauthToken: string;
  accountId: string;
  accountName: string;
  userId: string;
  keyId: string;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(password, salt, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: parseInt(n, 10),
    r: parseInt(r, 10),
    p: parseInt(p, 10),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword('forkoff-timing-equalizer');

@Injectable()
export class GatewayAuthService {
  private readonly logger = new Logger(GatewayAuthService.name);
  private keyCache = new Map<string, { entry: ResolvedKey | null; expires: number }>();

  constructor(
    private prisma: PrismaService,
    private tokenCrypto: TokenCryptoService,
  ) {}

  isEnabled(): boolean {
    return process.env.GATEWAY_ENABLED === 'true';
  }

  async login(
    username: string,
    password: string,
    label?: string,
  ): Promise<{ key: string; accountName: string }> {
    const user = await this.prisma.gatewayUser.findUnique({
      where: { username },
      include: { claudeAccount: true },
    });
    if (!user || user.disabled) {
      verifyPassword(password, DUMMY_HASH);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const key = 'fkgw_' + crypto.randomBytes(32).toString('base64url');
    await this.prisma.gatewayKey.create({
      data: {
        userId: user.id,
        hashedKey: crypto.createHash('sha256').update(key).digest('hex'),
        label: label?.slice(0, 100),
      },
    });
    this.logger.log(`Gateway login: user=${user.username} label=${label ?? 'none'}`);
    return { key, accountName: user.claudeAccount.name };
  }

  async signup(
    username: string,
    password: string,
    inviteCode: string,
  ): Promise<{ accountName: string }> {
    const account = await this.prisma.claudeAccount.findUnique({
      where: { inviteCode },
    });
    if (!account || account.disabled) {
      throw new UnauthorizedException('Invalid invite code');
    }
    if (username.length < 3 || password.length < 8) {
      throw new UnauthorizedException(
        'Username must be 3+ chars and password 8+ chars',
      );
    }
    const existing = await this.prisma.gatewayUser.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictException('Username already taken');
    }
    await this.prisma.gatewayUser.create({
      data: {
        username,
        passwordHash: hashPassword(password),
        claudeAccountId: account.id,
      },
    });
    this.logger.log(`Gateway signup: user=${username} account=${account.name}`);
    return { accountName: account.name };
  }

  async resolveKey(rawKey: string): Promise<ResolvedKey | null> {
    const hashed = crypto.createHash('sha256').update(rawKey).digest('hex');
    const cached = this.keyCache.get(hashed);
    if (cached && cached.expires > Date.now()) {
      return cached.entry;
    }
    const record = await this.prisma.gatewayKey.findUnique({
      where: { hashedKey: hashed },
      include: { user: { include: { claudeAccount: true } } },
    });
    let entry: ResolvedKey | null = null;
    if (
      record &&
      !record.revokedAt &&
      !record.user.disabled &&
      !record.user.claudeAccount.disabled
    ) {
      entry = {
        oauthToken: this.tokenCrypto.decrypt(record.user.claudeAccount.encryptedOauthToken),
        accountId: record.user.claudeAccount.id,
        accountName: record.user.claudeAccount.name,
        userId: record.userId,
        keyId: record.id,
      };
    }
    this.keyCache.set(hashed, { entry, expires: Date.now() + KEY_CACHE_TTL_MS });
    if (this.keyCache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of this.keyCache) {
        if (v.expires <= now) this.keyCache.delete(k);
      }
    }
    return entry;
  }

  touchLastUsed(keyId: string, accountId: string): void {
    const now = new Date();
    void this.prisma.gatewayKey
      .update({ where: { id: keyId }, data: { lastUsedAt: now } })
      .catch(() => {});
    void this.prisma.claudeAccount
      .update({ where: { id: accountId }, data: { lastUsedAt: now } })
      .catch(() => {});
  }
}
