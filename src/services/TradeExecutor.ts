/**
 * Trade Executor Service
 * 
 * Handles trade execution with duplicate checking, risk management,
 * and post-execution cleanup operations.
 */

import { IHttpClient } from './HttpClient';
import { ICacheService } from './CacheService';
import {
  TradeRequest,
  TradeResult,
  SwapRequest
} from '../types';
import { ErrorHandler } from '../utils/ErrorHandler';

/**
 * Trade Executor interface
 */
export interface ITradeExecutor {
  execute(trade: TradeRequest): Promise<TradeResult>;
}

/**
 * Trade Executor implementation
 * 
 * Executes buy transactions with duplicate prevention,
 * risk management, and automatic cleanup after successful trades.
 */
export class TradeExecutor implements ITradeExecutor {
  private logger?: any;

  constructor(
    private httpClient: IHttpClient,
    private cacheService: ICacheService,
    logger?: any
  ) {
    this.logger = logger;
  }

  /**
   * Execute a trade with full duplicate checking and cleanup
   * 
   * @param trade - Trade request with token, amount, and risk config
   * @returns Trade result with success status and transaction details
   */
  async execute(trade: TradeRequest): Promise<TradeResult> {
    const { tokenMint, amount, riskConfig } = trade;

    try {
      this.logger?.info('Starting trade execution', {
        tokenMint,
        amount,
        riskConfig
      });

      // Step 1: Check for duplicate trades
      const isDuplicate = await this.checkDuplicate(tokenMint);
      if (isDuplicate) {
        this.logger?.warn('Duplicate trade prevented', { tokenMint });
        return {
          success: false,
          tokenMint,
          error: 'Token already processed - duplicate trade prevented'
        };
      }

      // Step 2: Execute the swap transaction
      this.logger?.info('Executing swap transaction', { tokenMint, amount });
      const swapRequest: SwapRequest = {
        tradeType: 'buy',
        mint: tokenMint,
        amount,
        watchConfig: {
          takeProfitPercentage: riskConfig.takeProfitPercentage,
          stopLossPercentage: riskConfig.stopLossPercentage,
          enableTrailingStop: riskConfig.trailingStopEnabled,
          // Include trailingPercentage when trailing stop is enabled
          // Use stopLossPercentage as the trailing distance
          ...(riskConfig.trailingStopEnabled && {
            trailingPercentage: riskConfig.stopLossPercentage
          })
        }
      };

      const swapResult = await this.httpClient.performSwap(swapRequest);
      console.log('Swap Result:', swapResult);

      if (!swapResult.success) {
        this.logger?.error('Swap execution failed', {
          tokenMint,
          error: swapResult.error || swapResult.message
        });
        return {
          success: false,
          tokenMint,
          error: swapResult.error || swapResult.message || 'Swap execution failed'
        };
      }

      // Step 3: Post-execution cleanup
      this.logger?.info('Trade queued successfully, performing cleanup', {
        tokenMint,
        jobId: swapResult.jobId,
        queuePosition: swapResult.queuePosition
      });

      await this.markAsProcessed(tokenMint);
      await this.cleanupAfterPurchase(tokenMint);

      this.logger?.info('Trade execution completed', {
        tokenMint,
        jobId: swapResult.jobId,
        message: swapResult.message
      });

      return {
        success: true,
        tokenMint,
        transactionSignature: swapResult.jobId // Use jobId as the transaction identifier
      };

    } catch (error) {
      this.logger?.error('Trade execution error', {
        tokenMint,
        error: (error as Error).message
      });

      const errorMsg = ErrorHandler.formatErrorMessage(
        'Trade execution',
        error as Error,
        { tokenMint, amount }
      );

      return {
        success: false,
        tokenMint,
        error: errorMsg
      };
    }
  }

  /**
   * Check if token has already been processed (duplicate prevention)
   * 
   * Queries the processed tokens set in Redis to verify the token
   * has not been previously purchased.
   * 
   * @param tokenMint - Token mint address to check
   * @returns True if token has been processed, false otherwise
   */
  private async checkDuplicate(tokenMint: string): Promise<boolean> {
    try {
      this.logger?.debug('Checking for duplicate trade', { tokenMint });
      const isProcessed = await this.cacheService.isTokenProcessed(tokenMint);
      
      if (isProcessed) {
        this.logger?.info('Token already processed', { tokenMint });
      }
      
      return isProcessed;
    } catch (error) {
      this.logger?.error('Error checking duplicate', {
        tokenMint,
        error: (error as Error).message
      });
      // On error, assume not duplicate to avoid blocking valid trades
      return false;
    }
  }

  /**
   * Mark token as processed after successful trade
   * 
   * Adds the token mint to the processed tokens set in Redis
   * to prevent duplicate purchases.
   * 
   * @param tokenMint - Token mint address to mark as processed
   */
  private async markAsProcessed(tokenMint: string): Promise<void> {
    try {
      this.logger?.debug('Marking token as processed', { tokenMint });
      await this.cacheService.markTokenProcessed(tokenMint);
      this.logger?.info('Token marked as processed', { tokenMint });
    } catch (error) {
      this.logger?.error('Failed to mark token as processed', {
        tokenMint,
        error: (error as Error).message
      });
      // Don't throw - this is cleanup, shouldn't fail the trade
    }
  }

  /**
   * Cleanup after successful purchase
   * 
   * Deletes the mindmap data from Redis cache to prevent
   * re-evaluation and free up cache space.
   * 
   * @param tokenMint - Token mint address to cleanup
   */
  private async cleanupAfterPurchase(tokenMint: string): Promise<void> {
    try {
      this.logger?.debug('Cleaning up mindmap cache', { tokenMint });
      await this.cacheService.deleteMindmapData(tokenMint);
      this.logger?.info('Mindmap cache cleaned up', { tokenMint });
    } catch (error) {
      this.logger?.error('Failed to cleanup mindmap cache', {
        tokenMint,
        error: (error as Error).message
      });
      // Don't throw - this is cleanup, shouldn't fail the trade
    }
  }
}
