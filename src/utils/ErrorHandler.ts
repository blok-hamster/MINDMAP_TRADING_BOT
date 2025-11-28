/**
 * Error Handler Utility
 * 
 * Provides comprehensive error handling with retry logic, exponential backoff,
 * and error classification for the trading bot.
 */

/**
 * Error categories for classification
 */
export enum ErrorCategory {
  CONNECTION = 'CONNECTION',
  API = 'API',
  VALIDATION = 'VALIDATION',
  TRADE_EXECUTION = 'TRADE_EXECUTION',
  CACHE = 'CACHE',
  UNKNOWN = 'UNKNOWN'
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

/**
 * Classified error information
 */
export interface ClassifiedError {
  category: ErrorCategory;
  severity: ErrorSeverity;
  isRetryable: boolean;
  message: string;
  originalError: Error;
}

/**
 * Retry configuration options
 */
export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
    'ECONNRESET',
    'EPIPE',
    'socket hang up',
    'network timeout',
    'Request failed with status code 5',
    'Request failed with status code 429',
    'REDIS_CONNECTION_ERROR'
  ]
};

/**
 * Error Handler utility class
 * 
 * Provides methods for error classification, retry logic with exponential backoff,
 * and error handling strategies throughout the application.
 */
export class ErrorHandler {
  /**
   * Execute an operation with retry logic and exponential backoff
   * 
   * @param operation - Async function to execute
   * @param options - Retry configuration options
   * @param logger - Optional logger for tracking retry attempts
   * @returns Result of the operation
   * @throws Error if all retry attempts fail
   */
  static async withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {},
    logger?: any
  ): Promise<T> {
    const config = { ...DEFAULT_RETRY_OPTIONS, ...options };
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        // Log retry attempt if not the first attempt
        if (attempt > 0 && logger) {
          logger.info(`Retry attempt ${attempt}/${config.maxRetries}`);
        }

        // Execute the operation
        const result = await operation();
        
        // Log success if this was a retry
        if (attempt > 0 && logger) {
          logger.info(`Operation succeeded on retry attempt ${attempt}`);
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        const isRetryable = this.isRetryableError(lastError, config.retryableErrors);

        // Log the error
        if (logger) {
          logger.warn(`Operation failed (attempt ${attempt + 1}/${config.maxRetries + 1})`, {
            error: lastError.message,
            isRetryable,
            willRetry: isRetryable && attempt < config.maxRetries
          });
        }

        // If not retryable or last attempt, throw immediately
        if (!isRetryable || attempt >= config.maxRetries) {
          throw lastError;
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateBackoffDelay(
          attempt,
          config.initialDelayMs,
          config.maxDelayMs,
          config.backoffMultiplier
        );

        // Log delay information
        if (logger) {
          logger.debug(`Waiting ${delay}ms before retry`);
        }

        // Wait before next retry
        await this.delay(delay);
      }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError || new Error('Operation failed after all retries');
  }

  /**
   * Classify an error into category and severity
   * 
   * @param error - Error to classify
   * @returns Classified error information
   */
  static classifyError(error: Error): ClassifiedError {
    const message = error.message.toLowerCase();
    const stack = error.stack?.toLowerCase() || '';

    // Connection errors
    if (
      message.includes('econnrefused') ||
      message.includes('etimedout') ||
      message.includes('enotfound') ||
      message.includes('enetunreach') ||
      message.includes('econnreset') ||
      message.includes('socket hang up') ||
      message.includes('network timeout') ||
      message.includes('connection') ||
      stack.includes('socket')
    ) {
      return {
        category: ErrorCategory.CONNECTION,
        severity: ErrorSeverity.HIGH,
        isRetryable: true,
        message: 'Connection error occurred',
        originalError: error
      };
    }

    // API errors
    if (
      message.includes('status code') ||
      message.includes('api') ||
      message.includes('request failed') ||
      message.includes('response') ||
      message.includes('http')
    ) {
      // 5xx errors are retryable, 4xx are not
      const isServerError = message.includes('5') || message.includes('429');
      return {
        category: ErrorCategory.API,
        severity: isServerError ? ErrorSeverity.MEDIUM : ErrorSeverity.LOW,
        isRetryable: isServerError,
        message: 'API request error',
        originalError: error
      };
    }

    // Cache/Redis errors
    if (
      message.includes('redis') ||
      message.includes('cache') ||
      stack.includes('redis')
    ) {
      return {
        category: ErrorCategory.CACHE,
        severity: ErrorSeverity.MEDIUM,
        isRetryable: true,
        message: 'Cache operation error',
        originalError: error
      };
    }

    // Validation errors
    if (
      message.includes('invalid') ||
      message.includes('validation') ||
      message.includes('required') ||
      message.includes('missing') ||
      message.includes('malformed')
    ) {
      return {
        category: ErrorCategory.VALIDATION,
        severity: ErrorSeverity.LOW,
        isRetryable: false,
        message: 'Validation error',
        originalError: error
      };
    }

    // Trade execution errors
    if (
      message.includes('swap') ||
      message.includes('trade') ||
      message.includes('transaction') ||
      message.includes('insufficient') ||
      message.includes('slippage')
    ) {
      return {
        category: ErrorCategory.TRADE_EXECUTION,
        severity: ErrorSeverity.HIGH,
        isRetryable: false, // Don't retry trades automatically
        message: 'Trade execution error',
        originalError: error
      };
    }

    // Unknown errors
    return {
      category: ErrorCategory.UNKNOWN,
      severity: ErrorSeverity.MEDIUM,
      isRetryable: false,
      message: 'Unknown error occurred',
      originalError: error
    };
  }

  /**
   * Check if an error is retryable based on error patterns
   * 
   * @param error - Error to check
   * @param retryablePatterns - Array of error patterns that are retryable
   * @returns True if error is retryable
   */
  static isRetryableError(error: Error, retryablePatterns: string[]): boolean {
    const message = error.message.toLowerCase();
    const stack = error.stack?.toLowerCase() || '';

    return retryablePatterns.some(pattern => {
      const lowerPattern = pattern.toLowerCase();
      return message.includes(lowerPattern) || stack.includes(lowerPattern);
    });
  }

  /**
   * Calculate exponential backoff delay
   * 
   * @param attempt - Current attempt number (0-indexed)
   * @param initialDelay - Initial delay in milliseconds
   * @param maxDelay - Maximum delay in milliseconds
   * @param multiplier - Backoff multiplier
   * @returns Calculated delay in milliseconds
   */
  static calculateBackoffDelay(
    attempt: number,
    initialDelay: number,
    maxDelay: number,
    multiplier: number
  ): number {
    // Calculate exponential delay: initialDelay * (multiplier ^ attempt)
    const exponentialDelay = initialDelay * Math.pow(multiplier, attempt);
    
    // Add jitter (random variation) to prevent thundering herd
    const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
    
    // Cap at max delay
    return Math.min(exponentialDelay + jitter, maxDelay);
  }

  /**
   * Delay execution for specified milliseconds
   * 
   * @param ms - Milliseconds to delay
   * @returns Promise that resolves after delay
   */
  static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wrap an operation with error handling and logging
   * 
   * @param operation - Async function to execute
   * @param context - Context information for logging
   * @param logger - Logger instance
   * @returns Result of the operation or null on error
   */
  static async safeExecute<T>(
    operation: () => Promise<T>,
    context: string,
    logger?: any
  ): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      const classified = this.classifyError(error as Error);
      
      if (logger) {
        logger.error(`Error in ${context}`, {
          category: classified.category,
          severity: classified.severity,
          isRetryable: classified.isRetryable,
          message: classified.message,
          error: classified.originalError.message,
          stack: classified.originalError.stack
        });
      }

      return null;
    }
  }

  /**
   * Create a formatted error message with context
   * 
   * @param operation - Operation that failed
   * @param error - Original error
   * @param context - Additional context
   * @returns Formatted error message
   */
  static formatErrorMessage(
    operation: string,
    error: Error,
    context?: Record<string, any>
  ): string {
    const classified = this.classifyError(error);
    const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
    
    return `[${classified.category}] ${operation} failed: ${error.message}${contextStr}`;
  }

  /**
   * Handle WebSocket errors with appropriate logging and recovery
   * 
   * @param error - WebSocket error
   * @param logger - Logger instance
   * @returns True if error is recoverable
   */
  static handleWebSocketError(error: Error, logger?: any): boolean {
    const classified = this.classifyError(error);
    
    if (logger) {
      logger.error('WebSocket error occurred', {
        category: classified.category,
        severity: classified.severity,
        isRetryable: classified.isRetryable,
        message: error.message
      });
    }

    // WebSocket connection errors are typically recoverable
    return classified.category === ErrorCategory.CONNECTION || classified.isRetryable;
  }

  /**
   * Handle Redis/Cache errors with appropriate logging
   * 
   * @param error - Redis error
   * @param operation - Operation that failed
   * @param logger - Logger instance
   * @returns True if error is recoverable
   */
  static handleCacheError(error: Error, operation: string, logger?: any): boolean {
    const classified = this.classifyError(error);
    
    if (logger) {
      logger.error(`Cache error during ${operation}`, {
        category: classified.category,
        severity: classified.severity,
        isRetryable: classified.isRetryable,
        message: error.message
      });
    }

    return classified.isRetryable;
  }

  /**
   * Handle API errors with appropriate logging and retry decision
   * 
   * @param error - API error
   * @param endpoint - API endpoint that failed
   * @param logger - Logger instance
   * @returns True if error is retryable
   */
  static handleApiError(error: Error, endpoint: string, logger?: any): boolean {
    const classified = this.classifyError(error);
    
    if (logger) {
      logger.error(`API error for endpoint ${endpoint}`, {
        category: classified.category,
        severity: classified.severity,
        isRetryable: classified.isRetryable,
        message: error.message
      });
    }

    return classified.isRetryable;
  }
}
