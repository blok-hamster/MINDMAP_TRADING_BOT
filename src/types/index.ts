/**
 * Type definitions for the KOL Mindmap Trading Bot
 * 
 * This file will contain all TypeScript interfaces and types
 * used throughout the application.
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Filter criteria for evaluating mindmap data
 */
export interface FilterCriteria {
  minTradeVolume: number;
  minConnectedKOLs: number;
  minInfluenceScore: number;
  minTotalTrades: number;
}

/**
 * Risk management configuration for trade execution
 */
export interface RiskManagementConfig {
  takeProfitPercentage: number;
  stopLossPercentage: number;
  trailingStopEnabled: boolean;
}

/**
 * API configuration
 */
export interface ApiConfig {
  serverUrl: string;
  apiKey: string;
}

/**
 * Redis configuration
 */
export interface RedisConfig {
  url: string;
}

/**
 * Monitoring mode configuration
 */
export interface MonitoringConfig {
  mode: 'all' | 'subscribed';
}

/**
 * Trading configuration
 */
export interface TradingConfig {
  buyAmount: number;
}

/**
 * Logging configuration
 */
export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Complete bot configuration
 */
export interface BotConfig {
  api: ApiConfig;
  redis: RedisConfig;
  monitoring: MonitoringConfig;
  filter: FilterCriteria;
  risk: RiskManagementConfig;
  trading: TradingConfig;
  logging: LoggingConfig;
}

// ============================================================================
// Data Model Types
// ============================================================================

/**
 * KOL connection data within mindmap
 */
export interface KOLConnection {
  kolWallet: string;
  tradeCount: number;
  totalVolume: number;
  lastTradeTime: Date;
  influenceScore: number;
  tradeTypes: string[];
}

/**
 * Network metrics for mindmap data
 */
export interface NetworkMetrics {
  centrality: number;
  clustering: number;
  totalTrades: number;
}

/**
 * Mindmap data structure
 */
export interface MindmapData {
  tokenMint: string;
  kolConnections: {
    [kolWallet: string]: KOLConnection;
  };
  relatedTokens: string[];
  networkMetrics: NetworkMetrics;
  lastUpdate: Date;
}

// ============================================================================
// Service Interface Types
// ============================================================================

/**
 * Filter result from mindmap evaluation
 */
export interface FilterResult {
  passed: boolean;
  reason?: string;
  metrics: {
    totalVolume: number;
    connectedKOLs: number;
    avgInfluenceScore: number;
    totalTrades: number;
  };
}

/**
 * Prediction result from ML service
 * Matches the API's PredictionResult interface
 */
export interface PredictionResult {
  /** Task type this prediction applies to */
  taskType: string;
  
  // Classification-specific fields
  /** Predicted class index - classification only */
  classIndex?: number;
  /** Predicted class label - classification only */
  classLabel?: string;
  /** Prediction probability/confidence - classification only */
  probability?: number;
  /** All class probabilities (for multi-class) - classification only */
  probabilities?: number[];
  
  // Regression-specific fields
  /** Predicted numeric value - regression only */
  value?: number;
  /** Prediction confidence interval - regression only */
  confidenceInterval?: [number, number];
}

/**
 * Trade request for execution
 */
export interface TradeRequest {
  tokenMint: string;
  amount: number;
  riskConfig: RiskManagementConfig;
}

/**
 * Trade execution result
 */
export interface TradeResult {
  success: boolean;
  tokenMint: string;
  transactionSignature?: string;
  error?: string;
}

/**
 * Swap request to API (matches API's SwapData interface)
 */
export interface SwapRequest {
  tradeType: 'buy' | 'sell';
  amount: number;
  mint: string;
  watchConfig?: {
    takeProfitPercentage?: number;
    stopLossPercentage?: number;
    enableTrailingStop?: boolean;
    trailingPercentage?: number;
    maxHoldTimeMinutes?: number;
  };
}

/**
 * Swap result from API
 * Matches the response format from /perform-swap endpoint
 */
export interface SwapResult {
  success: boolean;
  jobId?: string;
  message?: string;
  error?: string;
  queuePosition?: number;
  totalQueued?: number;
}

/**
 * Bot status information
 */
export interface BotStatus {
  running: boolean;
  connected: boolean;
  tradesExecuted: number;
  tokensEvaluated: number;
  uptime: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * KOL trade update event
 */
export interface KOLTradeUpdateEvent {
  trade: {
    id: string;
    kolWallet: string;
    signature: string;
    timestamp: Date;
    tradeData: {
      tokenIn: string;
      tokenOut: string;
      mint: string;
      amountIn: number;
      amountOut: number;
      tradeType: 'buy' | 'sell';
    };
  };
  event: {
    id: string;
    type: string;
    timestamp: Date;
  };
}

/**
 * Mindmap update event
 */
export interface MindmapUpdateEvent {
  tokenMint: string;
  data: MindmapData; // Server sends 'data' field
  timestamp: Date;
}

/**
 * Subscription settings for advanced configuration
 */
export interface SubscriptionSettings {
  [key: string]: any;
}

/**
 * KOL Wallet information
 */
export interface KOLWallet {
  id: string;
  walletAddress: string;
  name?: string;
  description?: string;
  avatar?: string;
  socialLinks?: {
    twitter?: string;
    telegram?: string;
    website?: string;
    [key: string]: string | undefined;
  };
  isActive: boolean;
}

/**
 * KOL subscription data (matches API's UserSubscription interface)
 */
export interface KOLSubscription {
  id?: string;
  userId: string;
  kolWallet: string;
  isActive: boolean;
  copyPercentage?: number; // 0-100%
  tokenBuyCount?: number; // Number of times to buy a token
  maxAmount?: number;
  minAmount?: number;
  privateKey: string; // Encrypted
  walletAddress?: string;
  createdAt?: Date;
  type: 'trade' | 'watch';
  updatedAt?: Date;
  settings?: SubscriptionSettings;
  watchConfig?: {
    takeProfitPercentage?: number;
    stopLossPercentage?: number;
    enableTrailingStop?: boolean;
    trailingPercentage?: number;
    maxHoldTimeMinutes?: number;
  };
}
