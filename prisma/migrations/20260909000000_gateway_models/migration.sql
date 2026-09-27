CREATE TABLE "claude_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedOauthToken" TEXT NOT NULL,
    "inviteCode" TEXT,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claude_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gateway_users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "claudeAccountId" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gateway_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "label" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "claude_accounts_name_key" ON "claude_accounts"("name");

CREATE UNIQUE INDEX "claude_accounts_inviteCode_key" ON "claude_accounts"("inviteCode");

CREATE UNIQUE INDEX "gateway_users_username_key" ON "gateway_users"("username");

CREATE UNIQUE INDEX "gateway_keys_hashedKey_key" ON "gateway_keys"("hashedKey");

CREATE INDEX "gateway_keys_userId_idx" ON "gateway_keys"("userId");

ALTER TABLE "gateway_users" ADD CONSTRAINT "gateway_users_claudeAccountId_fkey" FOREIGN KEY ("claudeAccountId") REFERENCES "claude_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "gateway_keys" ADD CONSTRAINT "gateway_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "gateway_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
