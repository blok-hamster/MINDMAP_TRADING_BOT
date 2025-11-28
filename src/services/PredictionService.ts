/**
 * ML Prediction Service
 * 
 * Interfaces with the ML prediction endpoint to validate trade opportunities.
 * Applies confidence threshold and returns approval decisions.
 */

import { IHttpClient } from './HttpClient';
import { PredictionResult } from '../types';

/**
 * Prediction Service interface
 */
export interface IPredictionService {
  predict(tokenMint: string): Promise<PredictionResult & { approved: boolean; confidence: number }>;
}

/**
 * ML Prediction Service implementation
 * 
 * Wraps the HTTP client's prediction endpoint and applies
 * business logic for trade approval based on confidence scores.
 */
export class MLPredictionService implements IPredictionService {
  private httpClient: IHttpClient;
  private logger?: any;

  /**
   * Create a new ML Prediction Service
   * 
   * @param httpClient - HTTP client for API communication
   * @param logger - Optional logger instance
   */
  constructor(httpClient: IHttpClient, logger?: any) {
    this.httpClient = httpClient;
    this.logger = logger;
  }

  /**
   * Predict trade success probability for a token
   * 
   * Calls the ML prediction endpoint and applies the 69% confidence
   * threshold to determine if the trade should be approved.
   * 
   * @param tokenMint - Token mint address to predict
   * @returns Prediction result with approval decision
   * @throws Error if prediction API call fails
   */
  async predict(tokenMint: string): Promise<PredictionResult & { approved: boolean; confidence: number }> {
    try {
      this.logger?.info('Requesting ML prediction', { tokenMint });

      // Call prediction endpoint via HTTP client
      const result = await this.httpClient.predictTrade(tokenMint);

      // Extract confidence from probability (convert to percentage)
      const confidence = (result.probability || 0) * 100;
      
      // Apply 65% confidence threshold
      const approved = result.classLabel === 'good' && confidence >= 65;

      // Log prediction result
      this.logger?.info('ML prediction received', {
        tokenMint,
        taskType: result.taskType,
        classLabel: result.classLabel,
        probability: result.probability,
        confidence,
        approved
      });

      // Return result with approval logic applied
      return {
        ...result,
        confidence,
        approved
      };
    } catch (error) {
      this.logger?.error('ML prediction failed', {
        tokenMint,
        error: (error as Error).message
      });

      // Return rejection result on failure
      return {
        taskType: 'classification',
        classLabel: 'unknown',
        probability: 0,
        confidence: 0,
        approved: false
      };
    }
  }
}
