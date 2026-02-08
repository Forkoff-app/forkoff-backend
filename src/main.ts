import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { loadSecrets } from './config/secrets';

// Store server reference for graceful shutdown
let server: any;

async function bootstrap() {
  // Load secrets from AWS Secrets Manager before anything else
  await loadSecrets();

  const app = await NestFactory.create(AppModule, { rawBody: true });
  const logger = new Logger('HTTP');

  // Log all incoming requests to /devices
  app.use((req: Request, res: Response, next: NextFunction) => {
    const { method, url, headers } = req;
    if (url.includes('/devices')) {
      logger.log(`[${method}] ${url}`);
      logger.log(`Authorization header: ${headers.authorization ? headers.authorization.substring(0, 50) + '...' : 'NONE'}`);
    }
    next();
  });

  // Get config service
  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV') || 'development';

  // Enable CORS for mobile app
  const isProduction = nodeEnv === 'production' || nodeEnv === 'Prod';
  const allowedOrigins = configService.get<string>('ALLOWED_ORIGINS')?.split(',').map(o => o.trim()) || [];
  app.enableCors({
    origin: isProduction
      ? (allowedOrigins.length > 0 ? allowedOrigins : false)
      : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global prefix for all routes (except health check)
  app.setGlobalPrefix('api', {
    exclude: ['health'],
  });

  // Swagger documentation - only in development
  if (nodeEnv !== 'production' && nodeEnv !== 'Prod') {
    const config = new DocumentBuilder()
      .setTitle('ForkOff API')
      .setDescription(
        'API for ForkOff - Mobile companion app for AI-powered coding tools',
      )
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'Authorization',
          description: 'Enter Supabase JWT token',
          in: 'header',
        },
        'supabase-auth',
      )
      .addTag('health', 'Health check endpoint')
      .addTag('auth', 'Authentication & user profile')
      .addTag('devices', 'Device management & pairing')
      .addTag('projects', 'Project management')
      .addTag('chat', 'Chat sessions & messages')
      .addTag('terminal', 'Remote terminal sessions')
      .addTag('github', 'GitHub integration')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  const port = configService.get<number>('PORT') || 3000;
  server = await app.listen(port);

  console.log(`ForkOff API running on http://localhost:${port}`);
  if (nodeEnv !== 'production' && nodeEnv !== 'Prod') {
    console.log(`Swagger docs at http://localhost:${port}/docs`);
  }
  console.log(`WebSocket available on ws://localhost:${port}`);
  console.log(`Health check at http://localhost:${port}/health`);

  // Store app reference for graceful shutdown
  return app;
}

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  console.log(`\n⚠️  Received ${signal}. Starting graceful shutdown...`);

  if (server) {
    // Stop accepting new connections
    server.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(0);
    });

    // Force exit after 10 seconds if server doesn't close gracefully
    setTimeout(() => {
      console.error('❌ Forcing shutdown after 10 seconds');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

bootstrap();
