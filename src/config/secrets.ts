import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

interface SecretPayload {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  NODE_ENV?: string;
  PORT?: string;
}

const SECRET_NAME = 'forkoff-api';
const REGION = 'us-east-1';

/**
 * Loads secrets from AWS Secrets Manager and sets them as environment variables.
 * This should be called before any other initialization in the application.
 */
export async function loadSecrets(): Promise<void> {
  // Skip in development or if DATABASE_URL is already set (local dev)
  if (process.env.NODE_ENV === 'development' || process.env.DATABASE_URL) {
    console.log('📁 Using local environment variables');
    return;
  }

  console.log('🔐 Loading secrets from AWS Secrets Manager...');

  const client = new SecretsManagerClient({ region: REGION });

  try {
    const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    const response = await client.send(command);

    if (!response.SecretString) {
      throw new Error('Secret string is empty');
    }

    const secrets: SecretPayload = JSON.parse(response.SecretString);

    // Load all secret keys into process.env
    const requiredKeys: (keyof SecretPayload)[] = [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'DATABASE_URL',
      'JWT_SECRET',
    ];

    // Validate required keys exist
    for (const key of requiredKeys) {
      if (!secrets[key]) {
        throw new Error(`Missing required secret: ${key}`);
      }
    }

    // Set environment variables
    process.env.SUPABASE_URL = secrets.SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = secrets.SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = secrets.SUPABASE_SERVICE_ROLE_KEY;
    process.env.DATABASE_URL = secrets.DATABASE_URL;
    process.env.JWT_SECRET = secrets.JWT_SECRET;

    // Optional keys
    if (secrets.NODE_ENV) {
      process.env.NODE_ENV = secrets.NODE_ENV;
    }
    if (secrets.PORT) {
      process.env.PORT = secrets.PORT;
    }

    console.log('✅ Secrets loaded successfully from AWS Secrets Manager');
  } catch (error) {
    console.error('❌ Failed to load secrets from AWS Secrets Manager:', error);
    throw error;
  }
}
