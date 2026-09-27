import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as readline from 'readline';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function encryptToken(plaintext: string): string {
  const raw = process.env.GATEWAY_TOKEN_ENC_KEY;
  if (!raw) throw new Error('GATEWAY_TOKEN_ENC_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('GATEWAY_TOKEN_ENC_KEY must decode to 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1$${iv.toString('base64')}$${cipher.getAuthTag().toString('base64')}$${ct.toString('base64')}`;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    }) as readline.Interface & { _writeToOutput?: (s: string) => void };
    const original = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s: string) => {
      if (s.includes(question)) {
        original?.(question);
      } else if (s === '\r\n' || s === '\n') {
        original?.(s);
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function requireArg(name: string): string {
  const value = getArg(name);
  if (!value) {
    console.error(`Missing required argument: --${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const command = process.argv[2];
  const prisma = new PrismaClient();

  try {
    switch (command) {
      case 'add-account': {
        const name = requireArg('name');
        const token = requireArg('token');
        const inviteCode = getArg('invite-code') ?? null;
        await prisma.claudeAccount.create({
          data: { name, encryptedOauthToken: encryptToken(token), inviteCode },
        });
        console.log(`Account '${name}' created${inviteCode ? ` (invite code: ${inviteCode})` : ''}`);
        break;
      }
      case 'add-user': {
        const username = requireArg('username');
        const accountName = requireArg('account');
        const account = await prisma.claudeAccount.findUnique({ where: { name: accountName } });
        if (!account) throw new Error(`Account '${accountName}' not found`);
        const password = getArg('password') ?? (await promptHidden('Password: '));
        if (password.length < 8) throw new Error('Password must be 8+ characters');
        await prisma.gatewayUser.create({
          data: { username, passwordHash: hashPassword(password), claudeAccountId: account.id },
        });
        console.log(`User '${username}' created, mapped to account '${accountName}'`);
        break;
      }
      case 'map-user': {
        const username = requireArg('username');
        const accountName = requireArg('account');
        const account = await prisma.claudeAccount.findUnique({ where: { name: accountName } });
        if (!account) throw new Error(`Account '${accountName}' not found`);
        await prisma.gatewayUser.update({
          where: { username },
          data: { claudeAccountId: account.id },
        });
        console.log(`User '${username}' remapped to account '${accountName}'`);
        break;
      }
      case 'set-invite': {
        const accountName = requireArg('account');
        const code = getArg('code') ?? crypto.randomBytes(9).toString('base64url');
        await prisma.claudeAccount.update({
          where: { name: accountName },
          data: { inviteCode: code },
        });
        console.log(`Invite code for '${accountName}': ${code}`);
        break;
      }
      case 'rotate-token': {
        const accountName = requireArg('account');
        const token = requireArg('token');
        await prisma.claudeAccount.update({
          where: { name: accountName },
          data: { encryptedOauthToken: encryptToken(token) },
        });
        console.log(`Token rotated for account '${accountName}'`);
        break;
      }
      case 'revoke-key': {
        const keyId = getArg('id');
        const username = getArg('user');
        if (keyId) {
          await prisma.gatewayKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
          console.log(`Key ${keyId} revoked`);
        } else if (username) {
          const user = await prisma.gatewayUser.findUnique({ where: { username } });
          if (!user) throw new Error(`User '${username}' not found`);
          const result = await prisma.gatewayKey.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          console.log(`Revoked ${result.count} key(s) for '${username}'`);
        } else {
          throw new Error('Provide --id <keyId> or --user <username>');
        }
        break;
      }
      case 'disable-user': {
        const username = requireArg('username');
        const user = await prisma.gatewayUser.update({
          where: { username },
          data: { disabled: true },
        });
        await prisma.gatewayKey.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        console.log(`User '${username}' disabled and keys revoked`);
        break;
      }
      case 'list': {
        const accounts = await prisma.claudeAccount.findMany({
          include: { users: { include: { keys: true } } },
        });
        for (const account of accounts) {
          console.log(
            `Account: ${account.name}${account.disabled ? ' [DISABLED]' : ''}` +
              `${account.inviteCode ? ` invite=${account.inviteCode}` : ''}` +
              ` lastUsed=${account.lastUsedAt?.toISOString() ?? 'never'}`,
          );
          for (const user of account.users) {
            const activeKeys = user.keys.filter((k) => !k.revokedAt).length;
            console.log(
              `  User: ${user.username}${user.disabled ? ' [DISABLED]' : ''} activeKeys=${activeKeys}`,
            );
          }
        }
        if (accounts.length === 0) console.log('No accounts configured');
        break;
      }
      default:
        console.log(`Usage: gateway-admin <command> [options]

Commands:
  add-account   --name <n> --token <sk-ant-oat...> [--invite-code <code>]
  add-user      --username <u> --account <name> [--password <p>]
  map-user      --username <u> --account <name>
  set-invite    --account <name> [--code <code>]
  rotate-token  --account <name> --token <sk-ant-oat...>
  revoke-key    --id <keyId> | --user <username>
  disable-user  --username <u>
  list`);
        process.exit(command ? 1 : 0);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
