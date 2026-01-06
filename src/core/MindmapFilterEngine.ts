/**
 * Mindmap Filter Engine
 * 
 * Evaluates mindmap data against configured filter criteria to determine
 * if a token meets the requirements for trading consideration.
 */

import { FilterCriteria, FilterResult, MindmapData } from '../types';
import { BatchPriceService } from '../services/BatchPriceService';
import { getTokenSupplyFromChain, getSolPriceInUsd } from '../utils/solanaUtils';


/**
 * Interface for filter engine implementations
 */
export interface IFilterEngine {
  /**
   * Evaluate mindmap data against filter criteria
   * @param mindmapData The mindmap data to evaluate
   * @returns FilterResult with pass/fail status and metrics
   */
  evaluate(mindmapData: MindmapData): Promise<FilterResult>;

}

/**
 * Implementation of the mindmap filter engine
 * 
 * This class evaluates mindmap data by calculating aggregate metrics
 * (total volume, connected KOLs, average influence score) and comparing
 * them against configured thresholds.
 */
export class MindmapFilterEngine implements IFilterEngine {
  private criteria: FilterCriteria;
  
  // Native SOL/WSOL token address - should never be traded
  private readonly NATIVE_SOL_ADDRESS = 'So11111111111111111111111111111111111111112';

  /**
   * Create a new MindmapFilterEngine
   * @param criteria The filter criteria to use for evaluation
   * @param priceService The pricing service for market data
   */
  constructor(criteria: FilterCriteria, private priceService: BatchPriceService) {
    this.criteria = criteria;
    this.priceService = priceService;
  }

  /**
   * Evaluate mindmap data against filter criteria
   * @param mindmapData The mindmap data to evaluate
   * @returns FilterResult with pass/fail status and detailed metrics
   */
  async evaluate(mindmapData: MindmapData): Promise<FilterResult> {

    // First check: Reject native SOL token
    if (mindmapData.tokenMint === this.NATIVE_SOL_ADDRESS) {
      return {
        passed: false,
        reason: 'Token is native SOL (WSOL) - not a tradeable memecoin',
        metrics: {
          totalVolume: 0,
          connectedKOLs: 0,
          avgInfluenceScore: 0,
          totalTrades: 0,
        },
      };
    }

    // Calculate metrics from mindmap data
    const totalVolume = this.calculateTotalVolume(mindmapData);
    const connectedKOLs = this.countConnectedKOLs(mindmapData);
    const avgInfluenceScore = this.calculateAvgInfluenceScore(mindmapData);
    const totalTrades = mindmapData.networkMetrics.totalTrades;

    // Advanced Metrics
    const viralVelocity = this.calculateViralVelocity(mindmapData);
    const weightedVolume = this.calculateWeightedVolume(mindmapData);
    const consensusScore = this.calculateConsensus(mindmapData);
    
    const signals: string[] = [];

    // Check for Signals
    if (this.criteria.minViralVelocity && viralVelocity >= this.criteria.minViralVelocity) {
      signals.push('VIRAL_SPIKE');
    }

    if (this.criteria.requireSmartMoney && weightedVolume > (totalVolume * 0.6)) {
       // If weighted volume is > 60% of total volume, it means high influence KOLs are driving the volume
       signals.push('SMART_MONEY');
    }

    if (this.criteria.minConsensusScore && consensusScore >= this.criteria.minConsensusScore && connectedKOLs >= 3) {
      signals.push('HIGH_CONSENSUS');
    }

    const metrics = {
      totalVolume,
      connectedKOLs,
      avgInfluenceScore,
      totalTrades,
      viralVelocity,
      weightedVolume,
      consensusScore
    };

    // If we have strong signals, we might bypass some basic thresholds
    // But we still respect Hard Limits (like Min Liquidity/Market Cap)
    const hasStrongSignal = signals.length > 0;

    // Standard Criteria Checks (skipped if strong signal exists, optionally)
    // For now, let's say Signals act as override for "Volume" and "Trade" counts, 
    // but we still want minimum influence to avoid complete trash.
    
    if (!hasStrongSignal) {
        if (totalVolume < this.criteria.minTradeVolume) {
          return {
            passed: false,
            reason: `Total volume ${totalVolume.toFixed(2)} is below minimum ${this.criteria.minTradeVolume}`,
            metrics,
            signals
          };
        }

        if (connectedKOLs < this.criteria.minConnectedKOLs) {
          return {
            passed: false,
            reason: `Connected KOLs ${connectedKOLs} is below minimum ${this.criteria.minConnectedKOLs}`,
            metrics,
            signals
          };
        }

        if (totalTrades < this.criteria.minTotalTrades) {
          return {
            passed: false,
            reason: `Total trades ${totalTrades} is below minimum ${this.criteria.minTotalTrades}`,
            metrics,
            signals
          };
        }
    }

    // Always enforce Influence Score (quality control)
    if (avgInfluenceScore < this.criteria.minInfluenceScore) {
      return {
        passed: false,
        reason: `Average influence score ${avgInfluenceScore.toFixed(2)} is below minimum ${this.criteria.minInfluenceScore}`,
        metrics,
        signals
      };
    }

    // Check advanced on-chain filters (Market Cap / Liquidity)
    // Only fetch if required to save RPC calls
    if (this.criteria.minMarketCapUsd > 0 || this.criteria.minLiquidityUsd > 0) {
      try {
        // Use BatchPriceService to get price (Cached or Discovery)
        let price = await this.priceService.getCachedPrice(mindmapData.tokenMint);
        
        // If not in cache, try one-off discovery (main thread optimizes this)
        if (!price) {
             await this.priceService.discoverToken(mindmapData.tokenMint);
             price = await this.priceService.getCachedPrice(mindmapData.tokenMint);
        }

        if (!price) {
          return {
            passed: false,
            reason: 'Could not fetch on-chain price data for advanced filtering',
            metrics,
          };
        }

        // Check Market Cap
        if (this.criteria.minMarketCapUsd > 0) {
           const supplyData = await getTokenSupplyFromChain(mindmapData.tokenMint, process.env.SOLANA_RPC_URL!);
           
           if (!supplyData.success || supplyData.total_supply === 0) {
               return {
                 passed: false,
                 reason: 'Could not fetch token supply for Market Cap check',
                 metrics
               };
           }
           
           // Simplified Market Cap: Token Price * Total Supply
           // (Assuming Price is in USD directly, or we need SOL price? 
           // BatchPriceService usually returns price in SOL or USD depending on SDK. 
           // SDK getTokenPrice returns price in USD (usually) or SOL? 
           // Let's assume priceService returns USD for simplicity or we fetch SOL price.
           // BatchPriceService results seem to rely on Bonding Curve (SOL/Token) or Raydium (Quote/Base).
           // If Quote is SOL, Price is in SOL.
           // We need SOL Price in USD to convert if Price is in SOL.
           
           const solPriceUsd = await getSolPriceInUsd();
           const marketCapUsd = price * solPriceUsd * supplyData.total_supply;

           if (marketCapUsd < this.criteria.minMarketCapUsd) {
             return {
               passed: false,
               reason: `Market Cap $${marketCapUsd.toFixed(2)} is below minimum $${this.criteria.minMarketCapUsd}`,
               metrics,
             };
           }
        }

        // Liquidity check omitted for brevity/optimization (requires pool parsing which is heavy)
        // If needed, we can add it back using cached vault data.

      } catch (error) {
        console.warn(`Error during advanced filtering for ${mindmapData.tokenMint}:`, error);
        return {
            passed: false,
            reason: `Error during on-chain verification: ${(error as Error).message}`,
            metrics
        };
      }
    }

    // All criteria passed
    return {
      passed: true,
      metrics,
      signals
    };
  }

  /**
   * Calculate total trade volume across all KOL connections
   * @param mindmapData The mindmap data
   * @returns Total volume sum
   */
  private calculateTotalVolume(mindmapData: MindmapData): number {
    let totalVolume = 0;

    for (const kolWallet in mindmapData.kolConnections) {
      const connection = mindmapData.kolConnections[kolWallet];
      totalVolume += connection.totalVolume;
    }

    return totalVolume;
  }

  /**
   * Count the number of unique KOL connections
   * @param mindmapData The mindmap data
   * @returns Number of connected KOLs
   */
  private countConnectedKOLs(mindmapData: MindmapData): number {
    return Object.keys(mindmapData.kolConnections).length;
  }

  /**
   * Calculate average influence score across all KOL connections
   * @param mindmapData The mindmap data
   * @returns Average influence score
   */
  private calculateAvgInfluenceScore(mindmapData: MindmapData): number {
    const kolWallets = Object.keys(mindmapData.kolConnections);
    
    if (kolWallets.length === 0) {
      return 0;
    }

    let totalInfluenceScore = 0;

    for (const kolWallet of kolWallets) {
      const connection = mindmapData.kolConnections[kolWallet];
      totalInfluenceScore += connection.influenceScore;
    }

    return totalInfluenceScore / kolWallets.length;
  }

  /**
   * Calculate viral velocity (active KOLs in last minute)
   */
  private calculateViralVelocity(mindmapData: MindmapData): number {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60000);
    
    let activeKOLs = 0;
    for (const kolWallet in mindmapData.kolConnections) {
      const connection = mindmapData.kolConnections[kolWallet];
      // Check if last trade was within the last minute
      const lastTradeDate = new Date(connection.lastTradeTime);
      if (lastTradeDate > oneMinuteAgo) {
        activeKOLs++;
      }
    }
    return activeKOLs;
  }

  /**
   * Calculate influence-weighted volume (Smart Money flow)
   */
  private calculateWeightedVolume(mindmapData: MindmapData): number {
    let weightedVolume = 0;

    for (const kolWallet in mindmapData.kolConnections) {
      const connection = mindmapData.kolConnections[kolWallet];
      // Weight volume by influence score (0-100)
      // Influence 100 = 100% weight, Influence 50 = 50% weight
      weightedVolume += connection.totalVolume * (connection.influenceScore / 100);
    }

    return weightedVolume;
  }

  /**
   * Calculate buy consensus score (0-100%)
   */
  private calculateConsensus(mindmapData: MindmapData): number {
    let buyingKOLs = 0;
    let totalKOLs = 0;

    for (const kolWallet in mindmapData.kolConnections) {
      const connection = mindmapData.kolConnections[kolWallet];
      totalKOLs++;
      
      // Check if they are buying
      if (connection.tradeTypes.includes('buy')) {
        buyingKOLs++;
      }
    }

    if (totalKOLs === 0) return 0;
    
    return (buyingKOLs / totalKOLs) * 100;
  }

  /**
   * Update filter criteria
   * @param criteria Partial criteria to update
   */
  updateCriteria(criteria: Partial<FilterCriteria>): void {
    this.criteria = {
      ...this.criteria,
      ...criteria,
    };
  }
}
