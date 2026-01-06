import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { LoggingConfig } from '../types';

/**
 * Logger interface for structured logging throughout the application
 */
export interface ILogger {
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, error?: Error, meta?: any): void;
  debug(message: string, meta?: any): void;
  flush(): Promise<void>;
}

/**
 * Pino-based logger service implementation
 * Matches the logging style of the API service
 */
export class LoggerService implements ILogger {
  private logger: pino.Logger;

  constructor(config: LoggingConfig) {
    // Ensure logs directory exists
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir);
    }

    const streams = [
      // Console stream: formatted, info level and above
      {
        level: config.level || 'info',
        stream: pino.transport({
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            singleLine: true,
            messageFormat: '{msg}', 
          },
        }),
      },
      // File stream: raw JSON, debug level and above
      {
        level: 'debug',
        stream: pino.destination(path.join(logDir, 'bot.log')),
      },
    ];

    this.logger = pino(
      {
        level: 'debug', 
        base: null, 
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.multistream(streams)
    );
  }

  info(message: string, meta?: any): void {
    if (meta) {
      this.logger.info(meta, message);
    } else {
      this.logger.info(message);
    }
  }

  warn(message: string, meta?: any): void {
    if (meta) {
      this.logger.warn(meta, message);
    } else {
      this.logger.warn(message);
    }
  }

  error(message: string, error?: Error, meta?: any): void {
    const errorMeta = {
      ...meta,
      ...(error && {
        error: {
            message: error.message,
            stack: error.stack,
            name: error.name
        }
      })
    };
    this.logger.error(errorMeta, message);
  }

  debug(message: string, meta?: any): void {
    if (meta) {
      this.logger.debug(meta, message);
    } else {
      this.logger.debug(message);
    }
  }

  async flush(): Promise<void> {
    // Pino handles flushing automatically usually, but we can force it if needed
    // pino.destination is synchronous by default unless configured otherwise
    // For pino-pretty transport it might differ
    return Promise.resolve();
  }
}
