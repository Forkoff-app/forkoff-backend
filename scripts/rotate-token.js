const readline = require('readline');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste sk-ant-oat token: ', async (token) => {
  rl.close();
  token = token.trim();
  if (!token.startsWith('sk-ant-oat')) {
    console.error('That does not look like a setup-token (sk-ant-oat...)');
    process.exit(1);
  }
  const key = Buffer.from(process.env.GATEWAY_TOKEN_ENC_KEY, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const enc = `v1$${iv.toString('base64')}$${cipher.getAuthTag().toString('base64')}$${ct.toString('base64')}`;
  const prisma = new PrismaClient();
  await prisma.claudeAccount.update({ where: { name: 'main' }, data: { encryptedOauthToken: enc } });
  await prisma.$disconnect();
  console.log('Token rotated for account: main');
});
