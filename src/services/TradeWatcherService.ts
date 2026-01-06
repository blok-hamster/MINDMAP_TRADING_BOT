
import { TradeHistoryService, TradeHistoryEntry } from './TradeHistoryService';
import { BatchPriceService } from './BatchPriceService';
import { AgentLedgerTools } from './SolanaTxService';
import { config } from 'dotenv';
import { ILogger } from './LoggerService';

config();

export class TradeWatcherService {
  private tradeHistoryService: TradeHistoryService;
  private batchPriceService: BatchPriceService;
  private ledgerTools: AgentLedgerTools;
  private logger: ILogger;
  private checkInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly CHECK_INTERVAL_MS = 100;
  
  // Cache to prevent duplicate selling of the same trade in quick succession
  private processingTrades = new Set<string>();

  constructor(
    tradeHistoryService: TradeHistoryService,
    batchPriceService: BatchPriceService,
    ledgerTools: AgentLedgerTools,
    logger: ILogger
  ) {
    this.tradeHistoryService = tradeHistoryService;
    this.batchPriceService = batchPriceService;
    this.ledgerTools = ledgerTools;
    this.logger = logger;
  }

  /**
   * Start the monitoring loop
   */
  public start(): void {
    if (this.checkInterval) return;
    
    this.logger.info('👀 TradeWatcherService started');
    
    // Initial run
    this.processOpenTrades().catch(err => this.logger.error('Error in initial processOpenTrades', err as Error));
    
    // Start interval
    this.checkInterval = setInterval(() => {
      this.processOpenTrades().catch(err => this.logger.error('Error in processOpenTrades', err as Error));
    }, this.CHECK_INTERVAL_MS);

    // Heartbeat logger (every 60s)
    setInterval(async () => {
         try {
             const openTrades = await this.tradeHistoryService.getOpenTrades();
             if (openTrades.length > 0) {
                 this.logger.info(`💓 TradeWatcher Heartbeat: Watching ${openTrades.length} open position(s).`);
             } else {
                 this.logger.info(`💤 TradeWatcher Heartbeat: No open positions.`);
             }
         } catch(e) { /* ignore */ }
    }, 60000);
  }

  /**
   * Stop the monitoring loop
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.info('🛑 TradeWatcherService stopped');
    }
  }

  /**
   * Main processing loop
   */
  private async processOpenTrades(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 1. Get all open trades
      const openTrades = await this.tradeHistoryService.getOpenTrades();
      
      if (openTrades.length === 0) return;

      // 2. Collect unique mints
      const mints = [...new Set(openTrades.map(t => t.tokenMint))];
      
      // 3. Signal interest to BatchPriceService
      await Promise.all(mints.map(mint => this.batchPriceService.addTokenInterest(mint)));
      
      // 4. Process each trade
      await Promise.all(openTrades.map(async (trade) => {
        // Skip if already being processed in this cycle to prevent race conditions
        if (this.processingTrades.has(trade.id)) return;

        try {
            await this.evaluateTrade(trade);
        } catch (error) {
            this.logger.error(`Error evaluating trade ${trade.id}:`, error as Error);
        }
      }));

    } catch (error) {
      this.logger.error('Error in TradeWatcherService process loop:', error as Error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Evaluate a single trade
   */
  /**
   * Evaluate a single trade
   */
  private async evaluateTrade(trade: TradeHistoryEntry): Promise<void> {
    const now = Date.now();
    const holdTimeMinutes = (now - new Date(trade.openedAt).getTime()) / (1000 * 60);

    // 1. Critical Check: Max Hold Time (Priority over everything else)
    // We check this BEFORE fetching price to ensure trades always close on time
    // even if the price feed is dead or API is failing.
    if (trade.sellConditions.maxHoldTimeMinutes && holdTimeMinutes >= trade.sellConditions.maxHoldTimeMinutes) {
        // Log explicitly that we are enforcing time limit
        this.logger.info(`⏰ Max hold time reached for ${trade.tokenMint}: ${holdTimeMinutes.toFixed(1)}m / ${trade.sellConditions.maxHoldTimeMinutes}m`);
        
        // Pass 0 as current price if we don't know it yet. executeSell handles the swap.
        // We'll try to get cached price just for logging/records if possible
        const cachedPrice = await this.batchPriceService.getCachedPrice(trade.tokenMint) || 0;
        
        await this.executeSell(
            trade, 
            `Max hold time reached: ${holdTimeMinutes.toFixed(1)}m`, 
            cachedPrice
        );
        return;
    }

    // 2. Get current price
    const currentPrice = await this.batchPriceService.getCachedPrice(trade.tokenMint);
    
    // If price is missing, check if it's because the token is dead/errored
    if (currentPrice === null) {
        const isDead = await this.batchPriceService.hasPriceError(trade.tokenMint);
        if (isDead) {
             this.logger.warn(`⚠️ Trade ${trade.id} (${trade.tokenMint}) has persistent pricing error. Force closing.`);
             await this.tradeHistoryService.closeTrade({
                 tradeId: trade.id,
                 exitPrice: 0,
                 exitAmount: trade.entryAmount,
                 sellReason: 'Force Close: Token Pricing Error'
             });
        }
        return;
    }
    
    // 3. Update trade with latest price/stats locally
    trade.currentPrice = currentPrice;
    trade.lastPriceUpdate = new Date();
    
    // Update highest/lowest prices locally
    if (!trade.highestPrice || currentPrice > trade.highestPrice) {
      trade.highestPrice = currentPrice;
    }
    if (!trade.lowestPrice || currentPrice < trade.lowestPrice) {
      trade.lowestPrice = currentPrice;
    }

    // 4. Update trailing stop state if needed
    this.updateTrailingStopLoss(trade, currentPrice);
    
    // 5. Save and Broadcast
    await this.tradeHistoryService.updateTrade(trade);
    
    // Manually emit price update event since we skipped updateTradePrice helper
    this.tradeHistoryService.emit('price_update', { mint: trade.tokenMint, price: currentPrice });
    
    // 6. Check other sell conditions (Stop Loss, Take Profit, Trailing)
    // Note: We already checked Max Hold Time above, so checkSellConditions handles the rest
    const sellCheck = this.checkSellConditions(trade, currentPrice);
    
    if (sellCheck.shouldSell) {
       this.logger.info(`🚨 Sell triggered for ${trade.id} (${trade.tokenMint}): ${sellCheck.reason}`);
       await this.executeSell(trade, sellCheck.reason!, currentPrice);
    }
  }

   /**
   * Update trailing stop logic (Stepped Ratchet Mode)
   * 
   * Logic:
   * 1. Accumulation: Wait until profit hits TAKE_PROFIT_PERCENTAGE.
   * 2. Activation: 
   *    - Set 'stepLevel' = 1
   *    - Set 'currStopPrice' = CurrentPrice - TrailingPercentage 
   *    - Set 'nextTargetPrice' = CurrentPrice + TakeProfitPercentage
   * 3. Ratchet (Step Up):
   *    - If CurrentPrice >= nextTargetPrice:
   *      - stepLevel++
   *      - currStopPrice = CurrentPrice - TrailingPercentage (Locks in new profit chunk)
   *      - nextTargetPrice = CurrentPrice + TakeProfitPercentage (Moves goalpost)
   */
  private updateTrailingStopLoss(trade: TradeHistoryEntry, currentPrice: number): { activated: boolean; updated: boolean } {
      const conditions = trade.sellConditions;
      
      // Safety check: Must have TP and Trailing set for this logic to work
      if (!conditions.takeProfitPercentage || !conditions.trailingStopPercentage) {
          // Fallback to legacy behavior or just do nothing if config is invalid for stepped mode
          return { activated: false, updated: false };
      }

      let updated = false;

      // Update highest price (still useful for stats/legacy)
      if (!trade.highestPrice || currentPrice > trade.highestPrice) {
          trade.highestPrice = currentPrice;
          updated = true;
      }
      
      const tpPerc = conditions.takeProfitPercentage / 100;
      const trailPerc = conditions.trailingStopPercentage / 100;

      // Phase 1: Check for Activation
      if (!conditions.trailingStopActivated) {
           const priceChangePercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
           
           if (priceChangePercent >= conditions.takeProfitPercentage) {
               // ACTIVATE STEP 1
               conditions.trailingStopActivated = true;
               conditions.stepLevel = 1;
               
               // Initial Step Calculation
               // Base Base is the Current Price (the TP level)
               conditions.currStopPrice = currentPrice * (1 - trailPerc);
               conditions.nextTargetPrice = currentPrice * (1 + tpPerc); // Compounding ladder
               
               updated = true;
               this.logger.info(`✅ [Step 1] Stepped Trailing Activated for ${trade.id}!`);
               this.logger.info(`   Price: ${currentPrice} | Stop: ${conditions.currStopPrice} | Next Target: ${conditions.nextTargetPrice}`);
           }
      } 
      // Phase 2: Stepped Ratchet
      else if (conditions.trailingStopActivated && conditions.nextTargetPrice) {
          if (currentPrice >= conditions.nextTargetPrice) {
              // RATCHET UP
              const oldLevel = conditions.stepLevel || 1;
              conditions.stepLevel = oldLevel + 1;
              
              // New Base is Current Price (which effectively is the NextTargetPrice)
              conditions.currStopPrice = currentPrice * (1 - trailPerc);
              conditions.nextTargetPrice = currentPrice * (1 + tpPerc);
              
              updated = true;
              this.logger.info(`🚀 [Step ${conditions.stepLevel}] Trailing Stop Ratcheted Up for ${trade.id}!`);
              this.logger.info(`   Price: ${currentPrice} | New Stop: ${conditions.currStopPrice} | Next Target: ${conditions.nextTargetPrice}`);
          }
      }
      
      return { activated: !!conditions.trailingStopActivated, updated };
  }

  /**
   * Check if any sell conditions are met
   */
  private checkSellConditions(trade: TradeHistoryEntry, currentPrice: number): { shouldSell: boolean; reason?: string } {
    const conditions = trade.sellConditions;
    const entryPrice = trade.entryPrice;
    
    // 1. Calculate stats
    let priceChangePercent = 0;
    if (entryPrice > 0) {
        priceChangePercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
        // If entry price is 0 (data error?), we can't calculate change. 
        // Maybe treat as 0% or handle specially? For now 0%.
        priceChangePercent = 0;
    }

    const holdTimeMinutes = (Date.now() - new Date(trade.openedAt).getTime()) / (1000 * 60);

    // 2. Max Hold Time
    if (conditions.maxHoldTimeMinutes && holdTimeMinutes >= conditions.maxHoldTimeMinutes) {
        return { shouldSell: true, reason: `Max hold time reached: ${holdTimeMinutes.toFixed(1)}m` };
    }

    // 3. Stop Loss
    if (conditions.stopLossPercentage && priceChangePercent <= -conditions.stopLossPercentage) {
        return { shouldSell: true, reason: `Stop loss triggered: ${priceChangePercent.toFixed(2)}%` };
    }

    // 4. Take Profit
    if (conditions.takeProfitPercentage && !conditions.trailingStopPercentage) {
        if (priceChangePercent >= conditions.takeProfitPercentage) {
            return { shouldSell: true, reason: `Take profit reached: ${priceChangePercent.toFixed(2)}%` };
        }
    }

    // 5. Stepped Trailing Stop Loss
    if (conditions.trailingStopActivated && conditions.currStopPrice) {
        if (currentPrice <= conditions.currStopPrice) {
             const profitPerc = ((currentPrice - entryPrice) / entryPrice) * 100;
             return { shouldSell: true, reason: `Stepped Stop triggered: ${profitPerc.toFixed(2)}% (Stop Price: ${conditions.currStopPrice})` };
        }
    }
    // Fallback: Legacy Continuous Trailing (only if no TP was set, meaning no stepping)
    else if (conditions.trailingStopPercentage && !conditions.takeProfitPercentage && trade.highestPrice) {
        // ... (Keep implementation for explicit trailing-only trades if needed, or remove?)
        // The user explicity asked for stepped mode. 
        // But if they set trailing ONLY without TP, Step logic never activates.
        // So we keep this for "Dynamic Stop Loss" usage.
        const trailingDropPercent = ((currentPrice - trade.highestPrice) / trade.highestPrice) * 100;
        if (trailingDropPercent <= -conditions.trailingStopPercentage) {
             return { shouldSell: true, reason: `Trailing stop triggered: ${trailingDropPercent.toFixed(2)}%` };
        }
    }

    return { shouldSell: false };
  }

  /**
   * Execute the sell
   */
  private async executeSell(trade: TradeHistoryEntry, reason: string, currentPrice: number): Promise<void> {
     if (this.processingTrades.has(trade.id)) return;
     this.processingTrades.add(trade.id);

     try {
         this.logger.info(`Executing sell for ${trade.tokenMint} - Reason: ${reason}`);

         const result = await this.ledgerTools.performSwap({
             amount: trade.entryAmount,
             action: 'sell',
             mint: trade.tokenMint
         });

         if (result.success) {
             // Access txid from the specific properties of the data object or swapResponse
             const data = result.data as any;
             const txId = (data?.swapResponse as any)?.txid || (data?.swapResponse as any)?.transactionId || data?.txid || 'unknown_tx';
             const exitPrice = (data?.swapResponse as any)?.rate?.executionPrice || currentPrice || 0;
             const exitAmount = (data?.swapResponse as any)?.rate?.amountIn || trade.entryAmount;

             await this.tradeHistoryService.closeTrade({
                 tradeId: trade.id,
                 exitPrice: exitPrice,
                 exitAmount: exitAmount,
                 sellTransactionId: txId,
                 sellReason: reason
             });
             
             this.logger.info(`✅ Trade ${trade.id} sold and closed.`);
         } else {
             this.logger.error(`❌ Failed to sell ${trade.id}: ${result.message}`);

             // Critical Fix: If failure is due to "No token balance" or "Insufficient Paper Token Balance", the trade is effectively dead/already closed externally.
             // Force close it to break the infinite retry loop.
             if (result.message && (
                 result.message.includes('No token balance') || 
                 result.message.includes('insufficient funds') ||
                 result.message.includes('Insufficient Paper')
             )) {
                 this.logger.warn(`⚠️ Force closing trade ${trade.id} due to missing balance (Simulated/Real mismatch).`);
                 await this.tradeHistoryService.closeTrade({
                     tradeId: trade.id,
                     exitPrice: currentPrice || 0, // Close at current price to track vaguely correct PnL even if volume is wrong
                     exitAmount: 0,
                     sellReason: `Force Close: ${result.message}`
                 });
             }
         }

     } catch (error) {
         this.logger.error(`❌ Critical error executing sell for ${trade.id}:`, error as Error);
     } finally {
         this.processingTrades.delete(trade.id);
     }
  }
}
