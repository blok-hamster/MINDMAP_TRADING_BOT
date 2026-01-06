/**
 * Trade History Service
 * 
 * Manages trade lifecycle tracking for PnL calculation and analytics.
 * Stores trade data in Redis with efficient indexing for queries.
 */

import { createClient, RedisClientType } from 'redis';
import { WebSocketServer } from '../server/WebSocketServer';
import { EventEmitter } from 'events';

export interface TradeHistoryEntry {
  // Core identifiers
  id: string;
  agentId: string;
  tokenMint: string;
  isSimulation?: boolean;

  // ML Prediction Data
  prediction?: {
    taskType: string;
    classIndex?: number;
    classLabel?: string;
    probability?: number;
    confidence?: number;
    value?: number;
  };
  
  // Trade lifecycle
  status: 'open' | 'closed' | 'failed';
  openedAt: Date;
  closedAt?: Date;
  
  // Entry data
  entryPrice: number;
  entryAmount: number;
  entryValue: number; // entryPrice * entryAmount
  buyTransactionId?: string;
  
  // Exit data
  exitPrice?: number;
  exitAmount?: number;
  exitValue?: number; // exitPrice * exitAmount
  sellTransactionId?: string;
  sellReason?: string; // 'take_profit', 'stop_loss', 'trailing_stop', 'max_hold_time', 'manual'
  
  // PnL calculations
  realizedPnL?: number; // exitValue - entryValue
  realizedPnLPercentage?: number; // (exitValue - entryValue) / entryValue * 100
  
  // Price tracking
  highestPrice?: number;
  lowestPrice?: number;
  currentPrice?: number;
  lastPriceUpdate?: Date;
  
  // Trade configuration
  sellConditions: {
    takeProfitPercentage?: number;
    stopLossPercentage?: number;
    trailingStopPercentage?: number;
    trailingStopActivated?: boolean;
    maxHoldTimeMinutes?: number;
    // Stepped Trailing State
    stepLevel?: number;       // 1, 2, 3...
    nextTargetPrice?: number; // Price to hit to trigger next step
    currStopPrice?: number;   // Current active hard stop
  };
  
  // Metadata
  ledgerId?: string;
  originalTradeId?: string;
  watchJobId?: string;
  tags?: string[]; // e.g., ['copy_trade', 'kol_trade', 'manual']
  notes?: string;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

export interface TradeStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number; // percentage
  totalPnL: number;
  totalPnLPercentage: number;
  averagePnL: number;
  averagePnLPercentage: number;
  averageWinAmount: number;
  averageLossAmount: number;
  largestWin: number;
  largestLoss: number;
  averageHoldTime: number; // in minutes
}

export interface TradeQuery {
  agentId?: string;
  tokenMint?: string;
  status?: 'open' | 'closed' | 'failed';
  startDate?: Date;
  endDate?: Date;
  minPnL?: number;
  maxPnL?: number;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export class TradeHistoryService extends EventEmitter {
  private redis: RedisClientType;
  private readonly TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days in seconds
  
  // Redis key prefixes
  private readonly TRADE_KEY = 'trade:';
  private readonly AGENT_INDEX_KEY = 'agent_trades:';
  private readonly TOKEN_INDEX_KEY = 'token_trades:';
  private readonly OPEN_TRADES_KEY = 'open_trades';
  private readonly CLOSED_TRADES_KEY = 'closed_trades';
  private wsServer?: WebSocketServer;

  constructor(redisUrl?: string, wsServer?: WebSocketServer) {
    super();
    this.wsServer = wsServer;
    const url = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = createClient({ url });
    
    this.redis.on('error', (err) => {
      console.error('❌ Redis Client Error:', err);
    });
    
    this.redis.on('connect', () => {
      // console.log('📊 TradeHistoryService connected to Redis');
    });
    
    // Connect to Redis
    this.redis.connect().catch((err) => {
      console.error('❌ Failed to connect to Redis:', err);
    });
  }

  /**
   * Create a new trade entry when a buy is executed
   */
  async createTrade(params: {
    agentId: string;
    tokenMint: string;
    entryPrice: number;
    entryAmount: number;
    buyTransactionId?: string;
    ledgerId?: string;
    originalTradeId?: string;
    watchJobId?: string;
    sellConditions?: TradeHistoryEntry['sellConditions'];
    tags?: string[];
    prediction?: TradeHistoryEntry['prediction'];
    isSimulation?: boolean;
  }): Promise<TradeHistoryEntry> {
    const now = new Date();
    const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    
    // Build trade object with only defined properties
    const trade: TradeHistoryEntry = {
      id: tradeId,
      agentId: params.agentId,
      tokenMint: params.tokenMint,
      isSimulation: params.isSimulation || false,
      status: 'open',
      openedAt: now,
      entryPrice: params.entryPrice,
      entryAmount: params.entryAmount,
      entryValue: params.entryPrice * params.entryAmount,
      sellConditions: params.sellConditions || {},
      tags: params.tags || [],
      highestPrice: params.entryPrice,
      lowestPrice: params.entryPrice,
      currentPrice: params.entryPrice,
      lastPriceUpdate: now,
      createdAt: now,
      updatedAt: now
    };
    
    // Add optional properties only if they have values
    if (params.prediction) {
      trade.prediction = params.prediction;
    }
    if (params.buyTransactionId !== undefined) {
      trade.buyTransactionId = params.buyTransactionId;
    }
    if (params.ledgerId !== undefined) {
      trade.ledgerId = params.ledgerId;
    }
    if (params.originalTradeId !== undefined) {
      trade.originalTradeId = params.originalTradeId;
    }
    if (params.watchJobId !== undefined) {
      trade.watchJobId = params.watchJobId;
    }

    await this.storeTrade(trade);
    // console.log(`📊 Trade history created: ${tradeId} for agent ${params.agentId}`);
    
    // Broadcast trade creation
    this.wsServer?.broadcastTradeUpdate(trade);

    return trade;
  }
  
  /**
   * Ensure Redis connection is ready
   */
  private async ensureConnected(): Promise<void> {
    if (!this.redis.isOpen) {
      await this.redis.connect();
    }
  }

  /**
   * Update trade with current price (called during monitoring)
   */
  async updateTradePrice(tradeId: string, currentPrice: number): Promise<void> {
    const trade = await this.getTrade(tradeId);
    if (!trade || trade.status !== 'open') {
      return;
    }

    trade.currentPrice = currentPrice;
    trade.lastPriceUpdate = new Date();
    
    // Update highest/lowest prices
    if (!trade.highestPrice || currentPrice > trade.highestPrice) {
      trade.highestPrice = currentPrice;
    }
    if (!trade.lowestPrice || currentPrice < trade.lowestPrice) {
      trade.lowestPrice = currentPrice;
    }
    
    trade.updatedAt = new Date();
    await this.storeTrade(trade);
    
    // Broadcast price update for chart
    this.wsServer?.broadcastPriceUpdate({ mint: trade.tokenMint, price: currentPrice });
    
    // Broadcast full trade update (throttled in UI)
    this.wsServer?.broadcastTradeUpdate(trade);
  }

  /**
   * Verified: Update full trade object
   */
  async updateTrade(trade: TradeHistoryEntry): Promise<void> {
    await this.storeTrade(trade);
  }

  /**
   * Update trade with current price using Watch Job ID
   */
  async updateTradePriceByWatchId(watchJobId: string, currentPrice: number): Promise<void> {
    try {
      await this.ensureConnected();
      
      // Since we don't have a direct index for watchJobId, we iterate open trades
      // Optimization: In standard prod, we should add a Redis index for watchJobId -> tradeId
      const openIds = await this.redis.sMembers(this.OPEN_TRADES_KEY);
      
      for (const id of openIds) {
        const tradeData = await this.redis.get(this.TRADE_KEY + id);
        if (!tradeData) continue;
        
        const trade = JSON.parse(tradeData);
        if (trade.watchJobId === watchJobId) {
            await this.updateTradePrice(trade.id, currentPrice);
            return;
        }
      }
    } catch (error) {
       console.error(`Error updating trade price for watch job ${watchJobId}:`, error);
    }
  }

  /**
   * Close a trade when sold
   */
  async closeTrade(params: {
    tradeId: string;
    exitPrice: number;
    exitAmount: number;
    sellTransactionId?: string;
    sellReason?: string;
  }): Promise<TradeHistoryEntry | null> {
    const trade = await this.getTrade(params.tradeId);
    if (!trade) {
      console.error(`Trade ${params.tradeId} not found`);
      return null;
    }

    const now = new Date();
    trade.status = 'closed';
    trade.closedAt = now;
    trade.exitPrice = params.exitPrice;
    trade.exitAmount = params.exitAmount;
    trade.exitValue = params.exitPrice * params.exitAmount;
    
    // Only set optional properties if they have values
    if (params.sellTransactionId !== undefined) {
      trade.sellTransactionId = params.sellTransactionId;
    }
    if (params.sellReason !== undefined) {
      trade.sellReason = params.sellReason;
    }
    
    // Calculate PnL
    trade.realizedPnL = trade.exitValue - trade.entryValue;
    trade.realizedPnLPercentage = (trade.realizedPnL / trade.entryValue) * 100;
    
    trade.updatedAt = now;
    
    await this.storeTrade(trade);
    
    // console.log(`💰 Trade closed: ${params.tradeId}, PnL: ${trade.realizedPnL?.toFixed(4)} SOL (${trade.realizedPnLPercentage?.toFixed(2)}%)`);
    
    // Broadcast trade close
    this.wsServer?.broadcastTradeUpdate(trade);

    return trade;
  }

  /**
   * Get trade by ID
   */
  async getTrade(tradeId: string): Promise<TradeHistoryEntry | null> {
    try {
      await this.ensureConnected();
      const data = await this.redis.get(this.TRADE_KEY + tradeId);
      if (!data) return null;
      
      const trade = JSON.parse(data as string);
      // Convert date strings back to Date objects
      trade.openedAt = new Date(trade.openedAt);
      if (trade.closedAt) trade.closedAt = new Date(trade.closedAt);
      if (trade.lastPriceUpdate) trade.lastPriceUpdate = new Date(trade.lastPriceUpdate);
      trade.createdAt = new Date(trade.createdAt);
      trade.updatedAt = new Date(trade.updatedAt);
      
      return trade;
    } catch (error) {
      console.error(`Error retrieving trade ${tradeId}:`, error);
      return null;
    }
  }

  /**
   * Get all trades for an agent
   */
  async getTradesByAgent(agentId: string, status?: 'open' | 'closed'): Promise<TradeHistoryEntry[]> {
    try {
      await this.ensureConnected();
      const tradeIds = await this.redis.sMembers(this.AGENT_INDEX_KEY + agentId);
      const trades: TradeHistoryEntry[] = [];
      
      for (const tradeId of tradeIds) {
        const trade = await this.getTrade(tradeId);
        if (trade && (!status || trade.status === status)) {
          trades.push(trade);
        }
      }
      
      // Sort by creation date (newest first)
      return trades.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch (error) {
      console.error(`Error retrieving trades for agent ${agentId}:`, error);
      return [];
    }
  }

  /**
   * Get all trades for a token
   */
  async getTradesByToken(tokenMint: string): Promise<TradeHistoryEntry[]> {
    try {
      await this.ensureConnected();
      const tradeIds = await this.redis.sMembers(this.TOKEN_INDEX_KEY + tokenMint);
      const trades: TradeHistoryEntry[] = [];
      
      for (const tradeId of tradeIds) {
        const trade = await this.getTrade(tradeId);
        if (trade) {
          trades.push(trade);
        }
      }
      
      return trades.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch (error) {
      console.error(`Error retrieving trades for token ${tokenMint}:`, error);
      return [];
    }
  }

  /**
   * Get open trades for an agent
   */
  async getOpenTrades(agentId?: string): Promise<TradeHistoryEntry[]> {
    try {
      await this.ensureConnected();
      const tradeIds = await this.redis.sMembers(this.OPEN_TRADES_KEY);
      const trades: TradeHistoryEntry[] = [];
      
      for (const tradeId of tradeIds) {
        const trade = await this.getTrade(tradeId);
        if (trade && (!agentId || trade.agentId === agentId)) {
          trades.push(trade);
        }
      }
      
      return trades.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch (error) {
      console.error('Error retrieving open trades:', error);
      return [];
    }
  }

  /**
   * Calculate statistics for an agent
   */
  async getAgentStats(agentId: string, startDate?: Date, endDate?: Date): Promise<TradeStats> {
    const allTrades = await this.getTradesByAgent(agentId);
    
    // Filter by date range if provided
    let trades = allTrades;
    if (startDate || endDate) {
      trades = allTrades.filter(trade => {
        const tradeDate = trade.openedAt;
        if (startDate && tradeDate < startDate) return false;
        if (endDate && tradeDate > endDate) return false;
        return true;
      });
    }
    
    const closedTrades = trades.filter(t => t.status === 'closed');
    const openTrades = trades.filter(t => t.status === 'open');
    const winningTrades = closedTrades.filter(t => (t.realizedPnL || 0) > 0);
    const losingTrades = closedTrades.filter(t => (t.realizedPnL || 0) < 0);
    
    const totalPnL = closedTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
    const totalEntryValue = closedTrades.reduce((sum, t) => sum + t.entryValue, 0);
    const totalPnLPercentage = totalEntryValue > 0 ? (totalPnL / totalEntryValue) * 100 : 0;
    
    const winAmounts = winningTrades.map(t => t.realizedPnL || 0);
    const lossAmounts = losingTrades.map(t => Math.abs(t.realizedPnL || 0));
    
    const holdTimes = closedTrades
      .filter(t => t.closedAt)
      .map(t => (t.closedAt!.getTime() - t.openedAt.getTime()) / (1000 * 60));
    
    return {
      totalTrades: trades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0,
      totalPnL,
      totalPnLPercentage,
      averagePnL: closedTrades.length > 0 ? totalPnL / closedTrades.length : 0,
      averagePnLPercentage: closedTrades.length > 0 ? totalPnLPercentage / closedTrades.length : 0,
      averageWinAmount: winAmounts.length > 0 ? winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length : 0,
      averageLossAmount: lossAmounts.length > 0 ? lossAmounts.reduce((a, b) => a + b, 0) / lossAmounts.length : 0,
      largestWin: winAmounts.length > 0 ? Math.max(...winAmounts) : 0,
      largestLoss: lossAmounts.length > 0 ? Math.max(...lossAmounts) : 0,
      averageHoldTime: holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0
    };
  }

  /**
   * Query trades with filters
   */
  async queryTrades(query: TradeQuery): Promise<TradeHistoryEntry[]> {
    let trades: TradeHistoryEntry[] = [];
    
    // Start with agent or get all
    if (query.agentId) {
      trades = await this.getTradesByAgent(query.agentId);
    } else if (query.tokenMint) {
      trades = await this.getTradesByToken(query.tokenMint);
    } else {
      // Get all trades (expensive operation)
      await this.ensureConnected();
      const openIds = await this.redis.sMembers(this.OPEN_TRADES_KEY);
      const closedIds = await this.redis.sMembers(this.CLOSED_TRADES_KEY);
      const allIds = [...openIds, ...closedIds];
      
      for (const id of allIds) {
        const trade = await this.getTrade(id);
        if (trade) trades.push(trade);
      }
    }
    
    // Apply filters
    let filtered = trades;
    
    if (query.status) {
      filtered = filtered.filter(t => t.status === query.status);
    }
    
    if (query.startDate) {
      filtered = filtered.filter(t => t.openedAt >= query.startDate!);
    }
    
    if (query.endDate) {
      filtered = filtered.filter(t => t.openedAt <= query.endDate!);
    }
    
    if (query.minPnL !== undefined) {
      filtered = filtered.filter(t => (t.realizedPnL || 0) >= query.minPnL!);
    }
    
    if (query.maxPnL !== undefined) {
      filtered = filtered.filter(t => (t.realizedPnL || 0) <= query.maxPnL!);
    }
    
    if (query.tags && query.tags.length > 0) {
      filtered = filtered.filter(t => 
        query.tags!.some(tag => t.tags?.includes(tag))
      );
    }
    
    // Sort by creation date (newest first)
    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    
    // Apply pagination
    if (query.offset !== undefined || query.limit !== undefined) {
      const offset = query.offset || 0;
      const limit = query.limit || 100;
      filtered = filtered.slice(offset, offset + limit);
    }
    
    return filtered;
  }

  /**
   * Store trade in Redis with indexes
   */
  private async storeTrade(trade: TradeHistoryEntry): Promise<void> {
    await this.ensureConnected();
    
    try {
      // Store trade data with TTL
      const tradeKey = this.TRADE_KEY + trade.id;
      await this.redis.setEx(tradeKey, this.TTL_SECONDS, JSON.stringify(trade));
      
      // Add to agent index
      const agentKey = this.AGENT_INDEX_KEY + trade.agentId;
      await this.safeSetAdd(agentKey, trade.id);
      await this.safeExpire(agentKey, this.TTL_SECONDS);
      
      // Add to token index
      const tokenKey = this.TOKEN_INDEX_KEY + trade.tokenMint;
      await this.safeSetAdd(tokenKey, trade.id);
      await this.safeExpire(tokenKey, this.TTL_SECONDS);
      
      // Add to status set
      if (trade.status === 'open') {
        await this.safeSetAdd(this.OPEN_TRADES_KEY, trade.id);
        await this.safeSetRemove(this.CLOSED_TRADES_KEY, trade.id);
      } else if (trade.status === 'closed') {
        await this.safeSetAdd(this.CLOSED_TRADES_KEY, trade.id);
        await this.safeSetRemove(this.OPEN_TRADES_KEY, trade.id);
      }
      
      // Emit event for local listeners (Worker relay or Main Thread logic)
      this.emit('trade_update', trade);
      
    } catch (error) {
      console.error(`Error storing trade ${trade.id}:`, error);
      throw error;
    }
  }

  /**
   * Safely add to a Redis set, handling WRONGTYPE errors
   */
  private async safeSetAdd(key: string, value: string): Promise<void> {
    try {
      await this.redis.sAdd(key, value);
    } catch (error: any) {
      if (error.message && error.message.includes('WRONGTYPE')) {
        // Get the current value to see what was stored incorrectly
        const currentValue = await this.redis.get(key);
        const currentType = await this.redis.type(key);
        console.warn(`⚠️ Key ${key} has wrong type (${currentType}), current value: ${currentValue}`);
        console.warn(`   Deleting and recreating as a set...`);
        await this.redis.del(key);
        await this.redis.sAdd(key, value);
      } else {
        throw error;
      }
    }
  }

  /**
   * Safely remove from a Redis set, handling WRONGTYPE errors
   */
  private async safeSetRemove(key: string, value: string): Promise<void> {
    try {
      await this.redis.sRem(key, value);
    } catch (error: any) {
      if (error.message && error.message.includes('WRONGTYPE')) {
        console.warn(`⚠️ Key ${key} has wrong type, deleting...`);
        await this.redis.del(key);
      } else {
        throw error;
      }
    }
  }

  /**
   * Safely set expiration on a key, handling WRONGTYPE errors
   */
  private async safeExpire(key: string, seconds: number): Promise<void> {
    try {
      await this.redis.expire(key, seconds);
    } catch (error: any) {
      if (error.message && error.message.includes('WRONGTYPE')) {
        // Get the current value to see what was stored incorrectly
        const currentType = await this.redis.type(key);
        console.warn(`⚠️ Cannot set expiration on key ${key} (type: ${currentType}), deleting...`);
        await this.redis.del(key);
      } else {
        throw error;
      }
    }
  }

  /**
   * Delete a trade (admin function)
   */
  async deleteTrade(tradeId: string): Promise<boolean> {
    try {
      const trade = await this.getTrade(tradeId);
      if (!trade) return false;
      
      await this.ensureConnected();
      
      // Remove trade data
      await this.redis.del(this.TRADE_KEY + tradeId);
      
      // Remove from indexes
      await this.redis.sRem(this.AGENT_INDEX_KEY + trade.agentId, tradeId);
      await this.redis.sRem(this.TOKEN_INDEX_KEY + trade.tokenMint, tradeId);
      await this.redis.sRem(this.OPEN_TRADES_KEY, tradeId);
      await this.redis.sRem(this.CLOSED_TRADES_KEY, tradeId);
      
      return true;
    } catch (error) {
      console.error(`Error deleting trade ${tradeId}:`, error);
      return false;
    }
  }

  /**
   * Clear all data (for testing or cleanup)
   */
  async clearAll(): Promise<void> {
    try {
      await this.ensureConnected();
      
      // Get all trade IDs
      const openIds = await this.redis.sMembers(this.OPEN_TRADES_KEY);
      const closedIds = await this.redis.sMembers(this.CLOSED_TRADES_KEY);
      const allIds = [...openIds, ...closedIds];
      
      // Delete all trades and their indexes
      for (const tradeId of allIds) {
        await this.deleteTrade(tradeId);
      }
      
      // Clear status sets
      await this.redis.del(this.OPEN_TRADES_KEY);
      await this.redis.del(this.CLOSED_TRADES_KEY);
      
      console.log('🧹 All trade history cleared');
    } catch (error) {
      console.error('Error clearing trade history:', error);
    }
  }
  
  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    try {
      if (this.redis.isOpen) {
        await this.redis.quit();
        // console.log('📊 TradeHistoryService disconnected from Redis');
      }
    } catch (error) {
      console.error('Error closing Redis connection:', error);
    }
  }
  
  /**
   * Get storage statistics
   */
  async getStats(): Promise<{ totalTrades: number; openTrades: number; closedTrades: number; agents: number; tokens: number }> {
    try {
      await this.ensureConnected();
      
      const openCount = await this.redis.sCard(this.OPEN_TRADES_KEY);
      const closedCount = await this.redis.sCard(this.CLOSED_TRADES_KEY);
      
      // Count unique agents and tokens (expensive operation)
      const agentKeys = await this.redis.keys(this.AGENT_INDEX_KEY + '*');
      const tokenKeys = await this.redis.keys(this.TOKEN_INDEX_KEY + '*');
      
      return {
        totalTrades: openCount + closedCount,
        openTrades: openCount,
        closedTrades: closedCount,
        agents: agentKeys.length,
        tokens: tokenKeys.length
      };
    } catch (error) {
      console.error('Error getting stats:', error);
      return {
        totalTrades: 0,
        openTrades: 0,
        closedTrades: 0,
        agents: 0,
        tokens: 0
      };
    }
  }
}
