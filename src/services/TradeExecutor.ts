/**
 * Trade Executor Service
 * 
 * Handles trade execution with duplicate checking, risk management,
 * and post-execution cleanup operations.
 */

import { ICacheService } from './CacheService';
import {
  TradeRequest,
  TradeResult,
} from '../types';
import { ErrorHandler } from '../utils/ErrorHandler';
import { AgentLedgerTools } from './SolanaTxService'; // Import AgentLedgerTools

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
    private cacheService: ICacheService,
    private ledgerTools: AgentLedgerTools, // Inject AgentLedgerTools
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
    const { tokenMint, amount, riskConfig, prediction } = trade;

    try {
      this.logger?.info('Starting trade execution', {
        tokenMint,
        amount,
        riskConfig,
        hasPrediction: !!prediction
      });

      // Step 1: Duplicate check handled by BotCoreEngine
      // We rely on the orchestrator to enforce entry limits.
      // const isDuplicate = await this.checkDuplicate(tokenMint);
      // if (isDuplicate) { ... }

      // Step 2: Execute the swap transaction
      this.logger?.info('Executing swap transaction', { tokenMint, amount });
      
      const swapResult = await this.ledgerTools.performSwap({
        amount,
        action: 'buy',
        mint: tokenMint,
        watchConfig: {
          takeProfitPercentage: riskConfig.takeProfitPercentage,
          stopLossPercentage: riskConfig.stopLossPercentage,
          enableTrailingStop: riskConfig.trailingStopEnabled,
          trailingStopPercentage: riskConfig.trailingStopEnabled 
            ? (riskConfig.trailingStopPercentage || riskConfig.stopLossPercentage) 
            : undefined,
          maxHoldTimeMinutes: 60 // Default, can be exposed in riskConfig later
        },
        prediction // Pass prediction to SolanaTxService
      });
      // console.log('Swap Result:', swapResult);

      if (!swapResult.success) {
        this.logger?.error('Swap execution failed', {
          tokenMint,
          error: swapResult.message
        });
        return {
          success: false,
          tokenMint,
          error: swapResult.message || 'Swap execution failed'
        };
      }

      // Step 3: Post-execution cleanup
      this.logger?.info('Trade queued successfully, performing cleanup', {
        tokenMint,
        message: swapResult.message
      });

      await this.markAsProcessed(tokenMint);
      await this.cleanupAfterPurchase(tokenMint);

      this.logger?.info('Trade execution completed', {
        tokenMint,
        //jobId: swapResult.jobId,
        message: swapResult.message
      });

      return {
        success: true,
        tokenMint,
        transactionSignature: (swapResult.data as any)?.txid || (swapResult.data as any)?.swapResponse?.txid// Use txid as the transaction identifier
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
