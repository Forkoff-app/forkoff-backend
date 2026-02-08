import { WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';

const isProduction =
  process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'Prod';

const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

export const winstonConfig: WinstonModuleOptions = {
  level: logLevel,
  transports: [
    new winston.transports.Console({
      format: isProduction
        ? winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json(),
          )
        : winston.format.combine(
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            winston.format.colorize({ all: true }),
            winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
              const ctx = context ? `[${context}]` : '';
              const metaStr = Object.keys(meta).length
                ? ` ${JSON.stringify(meta)}`
                : '';
              return `${timestamp} ${level} ${ctx} ${message}${metaStr}`;
            }),
          ),
    }),
  ],
};
