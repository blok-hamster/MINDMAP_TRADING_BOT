/**
 * Mindmap Filter Engine
 * 
 * Evaluates mindmap data against configured filter criteria to determine
 * if a token meets the requirements for trading consideration.
 */

import { FilterCriteria, FilterResult, MindmapData } from '../types';

/**
 * Interface for filter engine implementations
 */
export interface IFilterEngine {
  /**
   * Evaluate mindmap data against filter criteria
   * @param mindmapData The mindmap data to evaluate
   * @returns FilterResult with pass/fail status and metrics
   */
  evaluate(mindmapData: MindmapData): FilterResult;
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
   */
  constructor(criteria: FilterCriteria) {
    this.criteria = criteria;
  }

  /**
   * Evaluate mindmap data against filter criteria
   * @param mindmapData The mindmap data to evaluate
   * @returns FilterResult with pass/fail status and detailed metrics
   */
  evaluate(mindmapData: MindmapData): FilterResult {
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

    const metrics = {
      totalVolume,
      connectedKOLs,
      avgInfluenceScore,
      totalTrades,
    };

    // Check against criteria thresholds
    if (totalVolume < this.criteria.minTradeVolume) {
      return {
        passed: false,
        reason: `Total volume ${totalVolume.toFixed(2)} is below minimum ${this.criteria.minTradeVolume}`,
        metrics,
      };
    }

    if (connectedKOLs < this.criteria.minConnectedKOLs) {
      return {
        passed: false,
        reason: `Connected KOLs ${connectedKOLs} is below minimum ${this.criteria.minConnectedKOLs}`,
        metrics,
      };
    }

    if (avgInfluenceScore < this.criteria.minInfluenceScore) {
      return {
        passed: false,
        reason: `Average influence score ${avgInfluenceScore.toFixed(2)} is below minimum ${this.criteria.minInfluenceScore}`,
        metrics,
      };
    }

    if (totalTrades < this.criteria.minTotalTrades) {
      return {
        passed: false,
        reason: `Total trades ${totalTrades} is below minimum ${this.criteria.minTotalTrades}`,
        metrics,
      };
    }

    // All criteria passed
    return {
      passed: true,
      metrics,
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
