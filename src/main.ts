import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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

  // Enable CORS for mobile app
  app.enableCors({
    origin: true, // Allow all origins in development
    credentials: true,
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

  // Global prefix for all routes
  app.setGlobalPrefix('api');

  // Swagger documentation
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

  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port);

  console.log(`🚀 ForkOff API running on http://localhost:${port}`);
  console.log(`📚 Swagger docs at http://localhost:${port}/docs`);
  console.log(`📡 WebSocket available on ws://localhost:${port}`);
}

bootstrap();
