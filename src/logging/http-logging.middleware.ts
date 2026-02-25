import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class HttpLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    // Skip health endpoint (ALB hits it every 30s)
    if (req.originalUrl === '/health') {
      return next();
    }

    const requestId =
      (req.headers['x-request-id'] as string) ||
      (req.headers['x-amzn-trace-id'] as string) ||
      randomUUID();

    // Attach to request for downstream use
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const start = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const { method, originalUrl } = req;
      const { statusCode } = res;
      const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.ip ||
        '-';
      const userAgent = req.headers['user-agent'] || '-';

      const logData = {
        requestId,
        method,
        url: originalUrl,
        statusCode,
        durationMs,
        ip: '[redacted]',
        userAgent,
      };

      if (statusCode >= 500) {
        this.logger.error(logData);
      } else if (statusCode >= 400) {
        this.logger.warn(logData);
      } else {
        this.logger.log(logData);
      }
    });

    next();
  }
}
