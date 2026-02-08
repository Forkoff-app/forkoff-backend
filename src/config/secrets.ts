import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

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
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRO_PRICE_ID?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
}

const SECRET_NAME = 'forkoff-api';
const REGION = 'us-east-1';

/**
 * Loads secrets from AWS Secrets Manager and sets them as environment variables.
 * Called before any other initialization in the application.
 */
export async function loadSecrets(): Promise<void> {
  // Skip in development or if DATABASE_URL is already set (local dev)
  if (process.env.NODE_ENV === 'development' || process.env.DATABASE_URL) {
    console.log('Using local environment variables');
    return;
  }

  console.log('Loading secrets from AWS Secrets Manager...');

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

    console.log('Secrets loaded successfully from AWS Secrets Manager');
  } catch (error) {
    console.error('Failed to load secrets from AWS Secrets Manager:', error);
    throw error;
  }
}
