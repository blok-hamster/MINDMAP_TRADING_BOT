/**
 * Bot Core Engine
 * 
 * Orchestrates the entire trading workflow by coordinating all services
 * and handling real-time events from the WebSocket connection.
 */

import { IWebSocketManager } from '../services/WebSocketManager';
import { ICacheService } from '../services/CacheService';
import { IHttpClient } from '../services/HttpClient';
import { IFilterEngine } from './MindmapFilterEngine';
import { IPredictionService } from '../services/PredictionService';
import { ITradeExecutor } from '../services/TradeExecutor';
import {
  BotConfig,
  BotStatus,
  KOLTradeUpdateEvent,
  MindmapUpdateEvent,
  MindmapData
} from '../types';
import { ErrorHandler } from '../utils/ErrorHandler';

/**
 * Bot Engine interface
 */
export interface IBotEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): BotStatus;
}

/**
 * Bot dependencies for dependency injection
 */
export interface BotDependencies {
  wsManager: IWebSocketManager;
  cacheService: ICacheService;
  httpClient: IHttpClient;
  filterEngine: IFilterEngine;
  predictionService: IPredictionService;
  tradeExecutor: ITradeExecutor;
  config: BotConfig;
  logger?: any;
}

/**
 * Bot Core Engine implementation
 * 
 * Coordinates all bot operations including:
 * - WebSocket connection management
 * - Real-time event processing
 * - Token evaluation pipeline
 * - Trade execution
 */
export class BotCoreEngine implements IBotEngine {
  private wsManager: IWebSocketManager;
  private cacheService: ICacheService;
  private httpClient: IHttpClient;
  private filterEngine: IFilterEngine;
  private predictionService: IPredictionService;
  private tradeExecutor: ITradeExecutor;
  private config: BotConfig;
  private logger?: any;

  // Status tracking
  private running: boolean = false;
  private connected: boolean = false;
  private tradesExecuted: number = 0;
  private tokensEvaluated: number = 0;
  private startTime: number = 0;

  constructor(dependencies: BotDependencies) {
    this.wsManager = dependencies.wsManager;
    this.cacheService = dependencies.cacheService;
    this.httpClient = dependencies.httpClient;
    this.filterEngine = dependencies.filterEngine;
    this.predictionService = dependencies.predictionService;
    this.tradeExecutor = dependencies.tradeExecutor;
    this.config = dependencies.config;
    this.logger = dependencies.logger;
  }

  /**
   * Get current bot status
   */
  getStatus(): BotStatus {
    const uptime = this.running ? Date.now() - this.startTime : 0;
    
    return {
      running: this.running,
      connected: this.connected,
      tradesExecuted: this.tradesExecuted,
      tokensEvaluated: this.tokensEvaluated,
      uptime: Math.floor(uptime / 1000) // Convert to seconds
    };
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    try {
      this.logger?.info('🚀 Starting KOL Mindmap Trading Bot...');
      
      // Initialize all services
      await this.initialize();
      
      // Load KOL list based on monitoring mode
      const kols = await this.loadKOLList();
      
      // Subscribe to WebSocket events
      this.setupEventHandlers();
      
      // Subscribe to KOL trades
      this.wsManager.subscribe(kols);
      
      // Mark as running
      this.running = true;
      this.startTime = Date.now();
      
      this.logger?.info('✅ Bot started successfully', {
        monitoringMode: this.config.monitoring.mode,
        kolCount: kols.length
      });
    } catch (error) {
      this.logger?.error('❌ Failed to start bot', error);
      throw error;
    }
  }

  /**
   * Stop the bot gracefully
   * 
   * Disconnects all services and flushes logs within 10 seconds.
   */
  async stop(): Promise<void> {
    try {
      this.logger?.info('🛑 Stopping bot gracefully...');
      
      // Mark as not running
      this.running = false;

      // Create a timeout promise for 10 second limit
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Shutdown timeout exceeded')), 10000);
      });

      // Create shutdown promise
      const shutdownPromise = this.performShutdown();

      // Race between shutdown and timeout
      await Promise.race([shutdownPromise, timeoutPromise]);

      this.logger?.info('✅ Bot stopped successfully');
    } catch (error) {
      this.logger?.error('Error during shutdown, forcing exit', error);
      // Force disconnect if graceful shutdown fails
      await this.forceShutdown();
    }
  }

  /**
   * Perform graceful shutdown of all services
   */
  private async performShutdown(): Promise<void> {
    const shutdownSteps: Promise<void>[] = [];

    // Disconnect WebSocket
    if (this.wsManager.isConnected()) {
      this.logger?.info('Disconnecting WebSocket...');
      shutdownSteps.push(
        this.wsManager.disconnect()
          .then(() => {
            this.connected = false;
            this.logger?.info('✅ WebSocket disconnected');
          })
          .catch(error => {
            this.logger?.error('Error disconnecting WebSocket', error);
          })
      );
    }

    // Close Redis connection
    this.logger?.info('Closing Redis connection...');
    shutdownSteps.push(
      this.cacheService.disconnect()
        .then(() => {
          this.logger?.info('✅ Redis disconnected');
        })
        .catch(error => {
          this.logger?.error('Error disconnecting Redis', error);
        })
    );

    // Wait for all shutdown steps to complete
    await Promise.allSettled(shutdownSteps);

    // Flush logs (if logger supports it)
    if (this.logger?.flush) {
      this.logger?.info('Flushing logs...');
      await this.logger.flush();
    }
  }

  /**
   * Force shutdown if graceful shutdown fails
   */
  private async forceShutdown(): Promise<void> {
    try {
      // Force disconnect WebSocket
      if (this.wsManager.isConnected()) {
        await this.wsManager.disconnect();
      }
      this.connected = false;

      // Force disconnect Redis
      await this.cacheService.disconnect();
    } catch (error) {
      // Ignore errors during force shutdown
      this.logger?.error('Error during force shutdown', error);
    }
  }

  /**
   * Initialize all services and establish connections
   */
  private async initialize(): Promise<void> {
    this.logger?.info('Initializing services...');
    
    try {
      // Connect to Redis
      this.logger?.info('Connecting to Redis...');
      await this.cacheService.connect();
      this.logger?.info('✅ Redis connected');
      
      // Connect to WebSocket
      this.logger?.info('Connecting to WebSocket...');
      await this.wsManager.connect();
      this.connected = true;
      this.logger?.info('✅ WebSocket connected');
      
      this.logger?.info('✅ All services initialized');
    } catch (error) {
      this.logger?.error('Failed to initialize services', error);
      throw error;
    }
  }

  /**
   * Load KOL list based on monitoring mode configuration
   */
  private async loadKOLList(): Promise<string[]> {
    this.logger?.info('Loading KOL list', {
      mode: this.config.monitoring.mode
    });
    
    try {
      let kols: string[];
      
      if (this.config.monitoring.mode === 'subscribed') {
        // Get user's subscribed KOLs
        this.logger?.info('Fetching user subscriptions...');
        const subscriptions = await this.httpClient.getUserSubscriptions();
        
        // Filter for active trade subscriptions only
        const activeTradeSubscriptions = subscriptions.filter(
          sub => sub.isActive && sub.type === 'trade'
        );
        
        kols = activeTradeSubscriptions.map(sub => sub.kolWallet);
        
        this.logger?.info('✅ Loaded subscribed KOLs', {
          total: subscriptions.length,
          active: activeTradeSubscriptions.length,
          monitoring: kols.length
        });
      } else {
        // Get all available KOLs
        this.logger?.info('Fetching all KOL wallets...');
        kols = await this.httpClient.getAllKOLWallets();
        this.logger?.info('✅ Loaded all KOLs', { count: kols.length });
      }
      
      if (kols.length === 0) {
        this.logger?.warn('⚠️ No KOLs found to monitor');
      }
      
      return kols;
    } catch (error) {
      this.logger?.error('Failed to load KOL list', error);
      throw error;
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    this.logger?.info('Setting up event handlers...');
    
    // Handle mindmap updates
    this.wsManager.on('mindmap_update', (data: MindmapUpdateEvent) => {
      this.handleMindmapUpdate(data).catch(error => {
        const errorMsg = ErrorHandler.formatErrorMessage(
          'handleMindmapUpdate',
          error as Error,
          { tokenMint: data.tokenMint }
        );
        this.logger?.error(errorMsg);
      });
    });
    
    // Handle KOL trade updates
    this.wsManager.on('kol_trade_update', (data: KOLTradeUpdateEvent) => {
      this.handleKOLTradeUpdate(data).catch(error => {
        const errorMsg = ErrorHandler.formatErrorMessage(
          'handleKOLTradeUpdate',
          error as Error,
          { kolWallet: data.trade.kolWallet }
        );
        this.logger?.error(errorMsg);
      });
    });
    
    // Handle connection events
    this.wsManager.on('connected', () => {
      this.connected = true;
      this.logger?.info('✅ WebSocket connected');
    });
    
    this.wsManager.on('disconnected', (reason: string) => {
      this.connected = false;
      this.logger?.warn('⚠️ WebSocket disconnected', { reason });
    });
    
    this.wsManager.on('error', (errorData: any) => {
      const error = errorData.error || errorData;
      const classified = ErrorHandler.classifyError(error);
      this.logger?.error('WebSocket error', {
        category: classified.category,
        severity: classified.severity,
        isRetryable: classified.isRetryable,
        message: error.message
      });
    });
    
    this.logger?.info('✅ Event handlers configured');
  }

  /**
   * Handle KOL trade update events
   * 
   * When a KOL makes a trade, update the cached mindmap data for affected tokens
   * by recalculating metrics and refreshing the cache.
   */
  private async handleKOLTradeUpdate(data: KOLTradeUpdateEvent): Promise<void> {
    try {
      this.logger?.debug('Received KOL trade update', {
        kolWallet: data.trade.kolWallet,
        tradeType: data.trade.tradeData.tradeType,
        mint: data.trade.tradeData.mint
      });

      // Extract affected token mints from trade data
      const affectedTokens = new Set<string>();
      
      // Add the main token mint
      if (data.trade.tradeData.mint) {
        affectedTokens.add(data.trade.tradeData.mint);
      }
      
      // Add tokenIn and tokenOut if they're different
      if (data.trade.tradeData.tokenIn) {
        affectedTokens.add(data.trade.tradeData.tokenIn);
      }
      if (data.trade.tradeData.tokenOut) {
        affectedTokens.add(data.trade.tradeData.tokenOut);
      }

      this.logger?.debug('Processing affected tokens', {
        count: affectedTokens.size,
        tokens: Array.from(affectedTokens)
      });

      // Update cached mindmap data for each affected token
      for (const tokenMint of affectedTokens) {
        try {
          // Load cached mindmap data with safe execution
          const cachedData = await ErrorHandler.safeExecute(
            () => this.cacheService.getMindmapData(tokenMint),
            `getMindmapData for ${tokenMint}`,
            this.logger
          );
          
          if (!cachedData) {
            this.logger?.debug('No cached mindmap data found for token', { tokenMint });
            continue;
          }

          // Recalculate mindmap metrics with new trade data
          const updatedData = await this.recalculateMindmapMetrics(
            cachedData,
            data.trade
          );

          // Update Redis cache with recalculated data
          await ErrorHandler.safeExecute(
            () => this.cacheService.updateMindmapData(tokenMint, updatedData),
            `updateMindmapData for ${tokenMint}`,
            this.logger
          );

          this.logger?.debug('Updated mindmap cache for token', {
            tokenMint,
            kolCount: Object.keys(updatedData.kolConnections).length,
            totalTrades: updatedData.networkMetrics.totalTrades
          });
        } catch (error) {
          const errorMsg = ErrorHandler.formatErrorMessage(
            'Update mindmap cache',
            error as Error,
            { tokenMint }
          );
          this.logger?.error(errorMsg);
        }
      }
    } catch (error) {
      this.logger?.error('Error handling KOL trade update', error);
    }
  }

  /**
   * Recalculate mindmap metrics based on new trade data
   * 
   * Updates KOL connection data (trade count, volume, timestamp) and
   * recalculates network metrics to reflect the latest trading activity.
   */
  private async recalculateMindmapMetrics(
    existingData: MindmapData,
    newTrade: KOLTradeUpdateEvent['trade']
  ): Promise<MindmapData> {
    const kolWallet = newTrade.kolWallet;
    const tradeData = newTrade.tradeData;

    // Update or add KOL connection
    if (!existingData.kolConnections[kolWallet]) {
      // Add new KOL connection if not present
      this.logger?.debug('Adding new KOL connection', {
        tokenMint: existingData.tokenMint,
        kolWallet
      });

      existingData.kolConnections[kolWallet] = {
        kolWallet,
        tradeCount: 0,
        totalVolume: 0,
        lastTradeTime: new Date(newTrade.timestamp),
        influenceScore: 0, // Will be calculated based on trading activity
        tradeTypes: []
      };
    }

    // Get the KOL connection to update
    const kolConnection = existingData.kolConnections[kolWallet];

    // Update trade count
    kolConnection.tradeCount += 1;

    // Update total volume based on trade type
    const tradeVolume = tradeData.tradeType === 'buy' 
      ? tradeData.amountOut 
      : tradeData.amountIn;
    kolConnection.totalVolume += tradeVolume;

    // Update last trade time
    kolConnection.lastTradeTime = new Date(newTrade.timestamp);

    // Add trade type if not already present
    if (!kolConnection.tradeTypes.includes(tradeData.tradeType)) {
      kolConnection.tradeTypes.push(tradeData.tradeType);
    }

    // Update influence score based on trading activity
    // Simple heuristic: higher volume and more trades = higher influence
    kolConnection.influenceScore = Math.min(
      100,
      (kolConnection.tradeCount * 10) + (kolConnection.totalVolume / 1000)
    );

    // Recalculate network metrics
    existingData.networkMetrics.totalTrades += 1;

    // Update timestamp
    existingData.lastUpdate = new Date();

    this.logger?.debug('Recalculated mindmap metrics', {
      tokenMint: existingData.tokenMint,
      kolWallet,
      tradeCount: kolConnection.tradeCount,
      totalVolume: kolConnection.totalVolume,
      influenceScore: kolConnection.influenceScore,
      networkTotalTrades: existingData.networkMetrics.totalTrades
    });

    return existingData;
  }

  /**
   * Handle mindmap update events
   * 
   * Cache received mindmap data and trigger token evaluation
   * if the token hasn't been processed yet.
   */
  private async handleMindmapUpdate(event: any): Promise<void> {
    try {
      // Handle both 'data' and 'mindmapData' field names for compatibility
      const tokenMint = event.tokenMint;
      const mindmapData = event.data || event.mindmapData;

      if (!tokenMint || !mindmapData) {
        this.logger?.error('Invalid mindmap update event', { event });
        return;
      }

      // Skip native SOL token (WSOL)
      const NATIVE_SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
      if (tokenMint === NATIVE_SOL_ADDRESS) {
        this.logger?.debug('Skipping native SOL token', { tokenMint });
        return;
      }

      this.logger?.info('Received mindmap update', {
        tokenMint,
        kolCount: Object.keys(mindmapData.kolConnections || {}).length,
        totalTrades: mindmapData.networkMetrics?.totalTrades || 0
      });

      // Cache received mindmap data in Redis
      await this.cacheService.cacheMindmapData(tokenMint, mindmapData);

      // Check if token is already processed
      const isProcessed = await this.cacheService.isTokenProcessed(tokenMint);
      
      if (isProcessed) {
        this.logger?.debug('Token already processed, skipping evaluation', {
          tokenMint
        });
        return;
      }

      // Trigger token evaluation
      this.logger?.info('Triggering token evaluation', { tokenMint });
      await this.processToken(tokenMint, mindmapData);

    } catch (error) {
      this.logger?.error('Error handling mindmap update', {
        error: (error as Error).message,
        stack: (error as Error).stack
      });
    }
  }

  /**
   * Process a token through the evaluation pipeline
   * 
   * Checks if token is already processed, retrieves or uses provided
   * mindmap data, and calls evaluateAndExecute.
   */
  private async processToken(
    tokenMint: string,
    providedMindmapData?: MindmapData
  ): Promise<void> {
    try {
      this.logger?.info('Processing token', { tokenMint });

      // Check if token is already processed (purchased)
      const isProcessed = await this.cacheService.isTokenProcessed(tokenMint);
      
      if (isProcessed) {
        this.logger?.info('Token already processed, skipping', { tokenMint });
        return;
      }

      // Check if token has permanently failed prediction
      const isPredictionFailed = await this.cacheService.isInSet(
        'bot:prediction_failed',
        tokenMint
      );
      
      if (isPredictionFailed) {
        this.logger?.debug('Token permanently failed prediction, skipping', {
          tokenMint
        });
        return;
      }

      // Retrieve mindmap data (use provided or fetch from cache)
      let mindmapData: MindmapData | null = providedMindmapData || null;
      
      if (!mindmapData) {
        this.logger?.debug('Fetching mindmap data from cache', { tokenMint });
        mindmapData = await this.cacheService.getMindmapData(tokenMint);
        
        if (!mindmapData) {
          this.logger?.warn('No mindmap data available for token', { tokenMint });
          return;
        }
      }

      // Call evaluateAndExecute method
      await this.evaluateAndExecute(tokenMint, mindmapData);

    } catch (error) {
      this.logger?.error('Error processing token', {
        tokenMint,
        error: (error as Error).message
      });
    }
  }

  /**
   * Evaluate and execute trade for a token
   * 
   * Orchestrates the complete evaluation pipeline:
   * 1. Filter engine evaluation
   * 2. ML prediction (if filter passes)
   * 3. Trade execution (if prediction approves)
   */
  private async evaluateAndExecute(
    tokenMint: string,
    mindmapData: MindmapData
  ): Promise<void> {
    try {
      this.tokensEvaluated++;

      this.logger?.info('🔍 Evaluating token', {
        tokenMint,
        evaluation: this.tokensEvaluated
      });

      // Step 1: Filter engine evaluation
      this.logger?.debug('Running filter engine', { tokenMint });
      const filterResult = this.filterEngine.evaluate(mindmapData);

      this.logger?.info('Filter result', {
        tokenMint,
        passed: filterResult.passed,
        reason: filterResult.reason,
        metrics: filterResult.metrics
      });

      if (!filterResult.passed) {
        this.logger?.info('❌ Token rejected by filter', {
          tokenMint,
          reason: filterResult.reason
        });
        return;
      }

      // Step 2: ML prediction with retry logic
      this.logger?.info('✅ Filter passed, requesting ML prediction', {
        tokenMint
      });

      // Check current retry count
      const retryCount = await this.cacheService.getPredictionRetryCount(tokenMint);
      const MAX_PREDICTION_RETRIES = 3;

      this.logger?.debug('Prediction retry status', {
        tokenMint,
        currentRetries: retryCount,
        maxRetries: MAX_PREDICTION_RETRIES
      });

      const predictionResult = await this.predictionService.predict(tokenMint);

      this.logger?.info('Prediction result', {
        tokenMint,
        taskType: predictionResult.taskType,
        classLabel: predictionResult.classLabel,
        probability: predictionResult.probability,
        confidence: predictionResult.confidence,
        approved: predictionResult.approved,
        retryAttempt: retryCount + 1
      });

      if (!predictionResult.approved) {
        // Increment retry count
        const newRetryCount = await this.cacheService.incrementPredictionRetryCount(tokenMint);

        if (newRetryCount >= MAX_PREDICTION_RETRIES) {
          // Max retries reached, permanently reject token
          await this.cacheService.markPredictionFailed(tokenMint);
          this.logger?.warn('❌ Token permanently rejected after max prediction retries', {
            tokenMint,
            confidence: predictionResult.confidence,
            totalAttempts: newRetryCount
          });
        } else {
          // Still have retries left, token can be re-evaluated
          this.logger?.info('❌ Token rejected by ML prediction, will retry', {
            tokenMint,
            confidence: predictionResult.confidence,
            attempt: newRetryCount,
            remainingRetries: MAX_PREDICTION_RETRIES - newRetryCount
          });
        }
        return;
      }

      // Step 3: Trade execution
      this.logger?.info('✅ Prediction approved, executing trade', {
        tokenMint,
        confidence: predictionResult.confidence
      });

      const tradeRequest = {
        tokenMint,
        amount: this.config.trading.buyAmount,
        riskConfig: this.config.risk
      };

      const tradeResult = await this.tradeExecutor.execute(tradeRequest);

      if (tradeResult.success) {
        this.tradesExecuted++;
        this.logger?.info('✅ Trade executed successfully', {
          tokenMint,
          signature: tradeResult.transactionSignature,
          totalTrades: this.tradesExecuted
        });
      } else {
        this.logger?.error('❌ Trade execution failed', {
          tokenMint,
          error: tradeResult.error
        });
      }

    } catch (error) {
      this.logger?.error('Error in evaluate and execute', {
        tokenMint,
        error: (error as Error).message
      });
    }
  }
}
