import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Logger } from '@nestjs/common';

interface SecretPayload {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
  DATABASE_URL: string;
  DIRECT_URL?: string;
  JWT_SECRET: string;
  NODE_ENV?: string;
  PORT?: string;
  PAIRING_CODE_EXPIRY_MINUTES?: string;
  ADMIN_EMAILS?: string;
  ALLOWED_ORIGINS?: string;
  GATEWAY_ENABLED?: string;
  GATEWAY_TOKEN_ENC_KEY?: string;
}

const SECRET_NAME = process.env.SECRETS_MANAGER_NAME || 'forkoff-api';
const REGION = 'us-east-1';
const logger = new Logger('Secrets');

/**
 * Loads secrets from AWS Secrets Manager and sets them as environment variables.
 * Called before any other initialization in the application.
 */
export async function loadSecrets(): Promise<void> {
  // Skip if DATABASE_URL is already set (true local dev)
  if (process.env.DATABASE_URL) {
    logger.log('Using local environment variables');
    return;
  }

  logger.log('Loading secrets from AWS Secrets Manager...');

  const client = new SecretsManagerClient({ region: REGION });

  try {
    const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    const response = await client.send(command);

    if (!response.SecretString) {
      throw new Error('Secret string is empty');
    }

    const secrets: SecretPayload = JSON.parse(response.SecretString);

    const requiredKeys: (keyof SecretPayload)[] = [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_KEY',
      'DATABASE_URL',
      'JWT_SECRET',
    ];

    for (const key of requiredKeys) {
      if (!secrets[key]) {
        throw new Error(`Missing required secret: ${key}`);
      }
    }

    // Set all secret keys into process.env
    for (const [key, value] of Object.entries(secrets)) {
      if (value) {
        process.env[key] = value;
      }
    }

    logger.log('Secrets loaded successfully from AWS Secrets Manager');
  } catch (error) {
    logger.error('Failed to load secrets from AWS Secrets Manager:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
