import { createClient, RedisClientType } from 'redis';
import { MindmapData } from '../types';
import { ErrorHandler } from '../utils/ErrorHandler';

/**
 * Interface for cache service operations
 */
export interface ICacheService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
  exists(key: string): Promise<boolean>;
  addToSet(key: string, value: string, ttl: number): Promise<void>;
  isInSet(key: string, value: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  cacheMindmapData(tokenMint: string, data: MindmapData): Promise<void>;
  getMindmapData(tokenMint: string): Promise<MindmapData | null>;
  updateMindmapData(tokenMint: string, data: MindmapData): Promise<void>;
  deleteMindmapData(tokenMint: string): Promise<void>;
  isTokenProcessed(tokenMint: string): Promise<boolean>;
  markTokenProcessed(tokenMint: string): Promise<void>;
  getEntryCount(tokenMint: string): Promise<number>;
  incrementEntryCount(tokenMint: string): Promise<number>;
  getPredictionRetryCount(tokenMint: string): Promise<number>;
  incrementPredictionRetryCount(tokenMint: string): Promise<number>;
  markPredictionFailed(tokenMint: string): Promise<void>;
  acquirePendingTradeLock(tokenMint: string): Promise<boolean>;
  releasePendingTradeLock(tokenMint: string): Promise<void>;
  resetTradingState(): Promise<void>;
}

/**
 * Redis-based cache service for mindmap data and processed tokens
 */
export class RedisCacheService implements ICacheService {
  private client: RedisClientType;
  private readonly MINDMAP_PREFIX = 'bot:mindmap:';
  private readonly PROCESSED_TOKENS_KEY = 'bot:processed_tokens';
  private readonly ENTRY_COUNT_PREFIX = 'bot:entry_count:';
  private readonly PREDICTION_RETRY_PREFIX = 'bot:prediction_retry:';
  private readonly PREDICTION_FAILED_KEY = 'bot:prediction_failed';
  private readonly DEFAULT_TTL = 1800; // 30 minutes in seconds
  private readonly RETRY_TTL = 3600; // 1 hour for retry tracking
  private readonly LOCK_TTL = 60; // 60 seconds lock timeout
  private readonly PENDING_TRADE_PREFIX = 'bot:pending_trade:';
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private logger?: any;

  constructor(private redisUrl: string, logger?: any) {
    this.logger = logger;
    this.client = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > this.MAX_RECONNECT_ATTEMPTS) {
            console.error(`❌ Redis reconnection failed after ${retries} attempts`);
            return new Error('Max reconnection attempts reached');
          }
          // Exponential backoff: 100ms, 200ms, 400ms, 800ms, etc.
          const delay = Math.min(100 * Math.pow(2, retries), 5000);
          console.log(`🔄 Redis reconnecting in ${delay}ms (attempt ${retries + 1}/${this.MAX_RECONNECT_ATTEMPTS})`);
          return delay;
        }
      }
    });

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for Redis connection lifecycle
   */
  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      this.logger?.info('Redis connection established');
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.client.on('ready', () => {
      this.logger?.info('Redis connection ready');
      this.isConnected = true;
    });

    this.client.on('error', (error) => {
      ErrorHandler.handleCacheError(error, 'Redis connection', this.logger);
      this.isConnected = false;
    });

    this.client.on('end', () => {
      this.logger?.info('Redis connection closed');
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      this.reconnectAttempts++;
      this.logger?.info('Redis reconnecting', {
        attempt: this.reconnectAttempts,
        maxAttempts: this.MAX_RECONNECT_ATTEMPTS
      });
    });
  }

  /**
   * Connect to Redis with error handling and retry logic
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      this.logger?.info('Redis already connected');
      return;
    }

    return ErrorHandler.withRetry(
      async () => {
        this.logger?.info('Connecting to Redis', { url: this.redisUrl });
        await this.client.connect();
        this.isConnected = true;
        this.logger?.info('Connected to Redis successfully');
      },
      {
        maxRetries: 5,
        initialDelayMs: 2000,
        maxDelayMs: 30000
      },
      this.logger
    );
  }

  /**
   * Gracefully disconnect from Redis
   */
  async disconnect(): Promise<void> {
    try {
      if (!this.isConnected) {
        this.logger?.info('Redis already disconnected');
        return;
      }

      this.logger?.info('Disconnecting from Redis');
      await this.client.quit();
      this.isConnected = false;
      this.logger?.info('Disconnected from Redis successfully');
    } catch (error) {
      this.logger?.error('Error disconnecting from Redis', {
        error: (error as Error).message
      });
      // Force disconnect if graceful quit fails
      await this.client.disconnect();
      this.isConnected = false;
    }
  }

  /**
   * Get a value by key
   */
  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      ErrorHandler.handleCacheError(error as Error, `get key ${key}`, this.logger);
      throw error;
    }
  }

  /**
   * Set a key-value pair with TTL
   */
  async set(key: string, value: string, ttl: number): Promise<void> {
    try {
      await this.client.setEx(key, ttl, value);
    } catch (error) {
      ErrorHandler.handleCacheError(error as Error, `set key ${key}`, this.logger);
      throw error;
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      ErrorHandler.handleCacheError(error as Error, `check existence of key ${key}`, this.logger);
      throw error;
    }
  }

  /**
   * Add a value to a set with TTL
   */
  async addToSet(key: string, value: string, ttl: number): Promise<void> {
    try {
      await this.client.sAdd(key, value);
      await this.client.expire(key, ttl);
    } catch (error) {
      ErrorHandler.handleCacheError(error as Error, `add to set ${key}`, this.logger);
      throw error;
    }
  }

  /**
   * Check if a value exists in a set
   */
  async isInSet(key: string, value: string): Promise<boolean> {
    try {
      return await this.client.sIsMember(key, value);
    } catch (error) {
      ErrorHandler.handleCacheError(error as Error, `check set membership for ${key}`, this.logger);
      throw error;
    }
  }

  /**
   * Delete a key
   */
  async delete(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      ErrorHandler.handleCacheError(error as Error, `delete key ${key}`, this.logger);
      throw error;
    }
  }

  /**
   * Cache mindmap data for a token with 30-minute TTL
   */
  async cacheMindmapData(tokenMint: string, data: MindmapData): Promise<void> {
    try {
      const key = `${this.MINDMAP_PREFIX}${tokenMint}`;
      const serializedData = JSON.stringify(data);
      await this.set(key, serializedData, this.DEFAULT_TTL);
      this.logger?.debug('Cached mindmap data', { tokenMint });
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `cache mindmap data for ${tokenMint}`,
        this.logger
      );
      throw error;
    }
  }

  /**
   * Get cached mindmap data for a token
   */
  async getMindmapData(tokenMint: string): Promise<MindmapData | null> {
    try {
      const key = `${this.MINDMAP_PREFIX}${tokenMint}`;
      const data = await this.get(key);
      
      if (!data) {
        return null;
      }

      return JSON.parse(data) as MindmapData;
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `get mindmap data for ${tokenMint}`,
        this.logger
      );
      return null;
    }
  }

  /**
   * Check if a token has been processed (purchased)
   */
  async isTokenProcessed(tokenMint: string): Promise<boolean> {
    try {
      return await this.isInSet(this.PROCESSED_TOKENS_KEY, tokenMint);
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `check if token ${tokenMint} is processed`,
        this.logger
      );
      return false;
    }
  }

  /**
   * Mark a token as processed (purchased)
   */
  async markTokenProcessed(tokenMint: string): Promise<void> {
    try {
      await this.addToSet(this.PROCESSED_TOKENS_KEY, tokenMint, this.DEFAULT_TTL);
      this.logger?.info('Marked token as processed', { tokenMint });
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `mark token ${tokenMint} as processed`,
        this.logger
      );
      throw error;
    }
  }

  /**
   * Get the number of times we have entered a position for a token
   */
  async getEntryCount(tokenMint: string): Promise<number> {
    try {
      const key = `${this.ENTRY_COUNT_PREFIX}${tokenMint}`;
      const count = await this.get(key);
      return count ? parseInt(count, 10) : (await this.isTokenProcessed(tokenMint) ? 1 : 0);
    } catch (error) {
       ErrorHandler.handleCacheError(
            error as Error,
            `get entry count for ${tokenMint}`,
            this.logger
       );
       return 0;
    }
  }

  /**
   * Increment the entry count for a token
   */
  async incrementEntryCount(tokenMint: string): Promise<number> {
    try {
        const key = `${this.ENTRY_COUNT_PREFIX}${tokenMint}`;
        // If tracking legacy 'processed' status, ensure we respect it
        if (await this.isTokenProcessed(tokenMint) && !(await this.exists(key))) {
            await this.set(key, '1', this.DEFAULT_TTL);
        }
        
        const count = await this.client.incr(key);
        await this.client.expire(key, this.DEFAULT_TTL);
        
        // Ensure we also mark as processed for backward compatibility
        await this.markTokenProcessed(tokenMint);
        
        this.logger?.debug('Incremented entry count', { tokenMint, count });
        return count;
    } catch (error) {
        ErrorHandler.handleCacheError(
            error as Error,
            `increment entry count for ${tokenMint}`,
            this.logger
        );
        throw error;
    }
  }

  /**
   * Update cached mindmap data and refresh TTL
   */
  async updateMindmapData(tokenMint: string, data: MindmapData): Promise<void> {
    try {
      const key = `${this.MINDMAP_PREFIX}${tokenMint}`;
      const serializedData = JSON.stringify(data);
      // Update data and refresh TTL
      await this.set(key, serializedData, this.DEFAULT_TTL);
      this.logger?.debug('Updated mindmap data', { tokenMint });
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `update mindmap data for ${tokenMint}`,
        this.logger
      );
      throw error;
    }
  }

  /**
   * Delete mindmap data from cache (used after token purchase)
   */
  async deleteMindmapData(tokenMint: string): Promise<void> {
    try {
      const key = `${this.MINDMAP_PREFIX}${tokenMint}`;
      await this.delete(key);
      this.logger?.info('Deleted mindmap data', { tokenMint });
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `delete mindmap data for ${tokenMint}`,
        this.logger
      );
      throw error;
    }
  }

  /**
   * Get prediction retry count for a token
   */
  async getPredictionRetryCount(tokenMint: string): Promise<number> {
    try {
      const key = `${this.PREDICTION_RETRY_PREFIX}${tokenMint}`;
      const count = await this.get(key);
      return count ? parseInt(count, 10) : 0;
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `get prediction retry count for ${tokenMint}`,
        this.logger
      );
      return 0;
    }
  }

  /**
   * Increment prediction retry count for a token
   * Returns the new count
   */
  async incrementPredictionRetryCount(tokenMint: string): Promise<number> {
    try {
      const key = `${this.PREDICTION_RETRY_PREFIX}${tokenMint}`;
      const currentCount = await this.getPredictionRetryCount(tokenMint);
      const newCount = currentCount + 1;
      await this.set(key, newCount.toString(), this.RETRY_TTL);
      this.logger?.debug('Incremented prediction retry count', {
        tokenMint,
        count: newCount
      });
      return newCount;
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `increment prediction retry count for ${tokenMint}`,
        this.logger
      );
      throw error;
    }
  }

  /**
   * Mark a token as permanently failed after max retries
   */
  async markPredictionFailed(tokenMint: string): Promise<void> {
    try {
      await this.addToSet(this.PREDICTION_FAILED_KEY, tokenMint, this.RETRY_TTL);
      this.logger?.info('Marked token prediction as permanently failed', {
        tokenMint
      });
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `mark prediction failed for ${tokenMint}`,
        this.logger
      );
      throw error;
    }
  }

  /**
   * Get connection status
   */
  isReady(): boolean {
    return this.isConnected;
  }

  /**
   * Get health information
   */
  getHealth() {
    return {
      connected: this.isConnected,
      url: this.redisUrl,
      reconnectAttempts: this.reconnectAttempts
    };
  }
  /**
   * Acquire a distributed lock for pending trade execution
   * Returns true if lock was acquired, false if already locked
   */
  async acquirePendingTradeLock(tokenMint: string): Promise<boolean> {
    try {
      const key = `${this.PENDING_TRADE_PREFIX}${tokenMint}`;
      // SET key value NX EX ttl
      // Returns 'OK' if set, null if not set (already exists)
      const result = await this.client.set(key, '1', {
        NX: true,
        EX: this.LOCK_TTL
      });
      
      const acquired = result === 'OK';
      if (acquired) {
        this.logger?.debug('Acquired pending trade lock', { tokenMint });
      } else {
        this.logger?.debug('Failed to acquire pending trade lock - already locked', { tokenMint });
      }
      
      return acquired;
    } catch (error) {
      ErrorHandler.handleCacheError(
        error as Error,
        `acquire pending trade lock for ${tokenMint}`,
        this.logger
      );
      // In case of Redis error, fail safe (don't trade) or fail open?
      // Fail safe is better to avoid double buys
      return false;
    }
  }

  /**
   * Release the pending trade lock
   */
  async releasePendingTradeLock(tokenMint: string): Promise<void> {
    try {
      const key = `${this.PENDING_TRADE_PREFIX}${tokenMint}`;
      await this.delete(key);
      this.logger?.debug('Released pending trade lock', { tokenMint });
    } catch (error) {
      // Just log error, lock will auto-expire
      ErrorHandler.handleCacheError(
        error as Error,
        `release pending trade lock for ${tokenMint}`,
        this.logger
      );
    }
  }

  /**
   * Reset all trading state (processed tokens, entry counts, retries, failures)
   * Useful for resetting paper trading environment
   */
  async resetTradingState(): Promise<void> {
    try {
      this.logger?.warn('🔄 Resetting all trading state in cache...');
      
      // Delete sets
      await this.delete(this.PROCESSED_TOKENS_KEY);
      await this.delete(this.PREDICTION_FAILED_KEY);
      
      // Delete patterns
      // Note: keys() is blocking and dangerous in prod, but fine for a reset script/dev
      const entryKeys = await this.client.keys(`${this.ENTRY_COUNT_PREFIX}*`);
      if (entryKeys.length > 0) await this.client.del(entryKeys);
      
      const retryKeys = await this.client.keys(`${this.PREDICTION_RETRY_PREFIX}*`);
      if (retryKeys.length > 0) await this.client.del(retryKeys);

      const lockKeys = await this.client.keys(`${this.PENDING_TRADE_PREFIX}*`);
      if (lockKeys.length > 0) await this.client.del(lockKeys);
      
      this.logger?.info('✅ Trading state reset complete');
    } catch (error) {
       ErrorHandler.handleCacheError(
        error as Error,
        'reset trading state',
        this.logger
       );
       throw error;
    }
  }
}

