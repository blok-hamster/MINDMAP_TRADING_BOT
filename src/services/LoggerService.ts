import winston from 'winston';
import { LoggingConfig } from '../types';

/**
 * Logger interface for structured logging throughout the application
 */
export interface ILogger {
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, error?: Error, meta?: any): void;
  debug(message: string, meta?: any): void;
}

/**
 * Winston-based logger service implementation
 * Provides structured logging with console and file transports
 */
export class LoggerService implements ILogger {
  private logger: winston.Logger;

  constructor(config: LoggingConfig) {
    // Define log format with timestamps and metadata
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    );

    // Console format for better readability
    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let metaStr = '';
        if (Object.keys(meta).length > 0) {
          // Filter out empty objects and format metadata
          const filteredMeta = Object.entries(meta)
            .filter(([key]) => key !== 'timestamp' && key !== 'level' && key !== 'message')
            .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
          
          if (Object.keys(filteredMeta).length > 0) {
            metaStr = ` ${JSON.stringify(filteredMeta)}`;
          }
        }
        return `${timestamp} [${level}]: ${message}${metaStr}`;
      })
    );

    // Create transports
    const transports: winston.transport[] = [
      // Console transport with colored output
      new winston.transports.Console({
        format: consoleFormat,
        level: config.level,
      }),
      // File transport for all logs
      new winston.transports.File({
        filename: 'logs/bot.log',
        format: logFormat,
        level: config.level,
        maxsize: 10485760, // 10MB
        maxFiles: 5,
      }),
      // Separate file for errors
      new winston.transports.File({
        filename: 'logs/error.log',
        format: logFormat,
        level: 'error',
        maxsize: 10485760, // 10MB
        maxFiles: 5,
      }),
    ];

    // Initialize Winston logger
    this.logger = winston.createLogger({
      level: config.level,
      format: logFormat,
      transports,
      exitOnError: false,
    });
  }

  /**
   * Log informational messages
   * @param message - Log message
   * @param meta - Optional metadata object
   */
  info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }

  /**
   * Log warning messages
   * @param message - Log message
   * @param meta - Optional metadata object
   */
  warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }

  /**
   * Log error messages with optional error object
   * @param message - Log message
   * @param error - Optional Error object
   * @param meta - Optional metadata object
   */
  error(message: string, error?: Error, meta?: any): void {
    const errorMeta = {
      ...meta,
      ...(error && {
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      }),
    };
    this.logger.error(message, errorMeta);
  }

  /**
   * Log debug messages
   * @param message - Log message
   * @param meta - Optional metadata object
   */
  debug(message: string, meta?: any): void {
    this.logger.debug(message, meta);
  }

  /**
   * Flush all pending logs (useful for graceful shutdown)
   */
  async flush(): Promise<void> {
    return new Promise((resolve) => {
      // Wait for all transports to finish writing
      const transports = this.logger.transports;
      let pending = transports.length;

      if (pending === 0) {
        resolve();
        return;
      }

      transports.forEach((transport) => {
        if (transport instanceof winston.transports.File) {
          transport.on('finish', () => {
            pending--;
            if (pending === 0) {
              resolve();
            }
          });
          transport.end();
        } else {
          pending--;
          if (pending === 0) {
            resolve();
          }
        }
      });
    });
  }
}
