/**
 * HTTP Client Service
 * 
 * Handles all HTTP requests to the API server with proper authentication,
 * error handling, and logging.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  KOLSubscription,
  KOLWallet,
  PredictionResult,
  SwapRequest,
  SwapResult
} from '../types';
import { ErrorHandler } from '../utils/ErrorHandler';

/**
 * HTTP Client interface for API communication
 */
export interface IHttpClient {
  get<T>(endpoint: string): Promise<T>;
  post<T>(endpoint: string, data: any): Promise<T>;
  getUserSubscriptions(): Promise<KOLSubscription[]>;
  getAllKOLWallets(): Promise<string[]>;
  getKOLWalletDetails(): Promise<KOLWallet[]>;
  predictTrade(tokenMint: string): Promise<PredictionResult>;
  performSwap(request: SwapRequest): Promise<SwapResult>;
}

/**
 * HTTP Client configuration
 */
export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  retries?: number;
}

/**
 * API HTTP Client implementation
 * 
 * Provides typed methods for all API endpoints with built-in
 * authentication, logging, and error handling.
 */
export class ApiHttpClient implements IHttpClient {
  private axios: AxiosInstance;
  private logger?: any; // Will be injected if available

  constructor(config: HttpClientConfig, logger?: any) {
    this.logger = logger;

    // Configure axios instance
    this.axios = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout || 30000, // 30 second default timeout
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey
      }
    });

    // Request interceptor for logging
    this.axios.interceptors.request.use(
      (requestConfig) => {
        this.logger?.debug('HTTP Request', {
          method: requestConfig.method?.toUpperCase(),
          url: requestConfig.url,
          baseURL: requestConfig.baseURL,
          data: requestConfig.data
        });
        return requestConfig;
      },
      (error) => {
        this.logger?.error('HTTP Request Error', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for logging
    this.axios.interceptors.response.use(
      (response) => {
        this.logger?.debug('HTTP Response', {
          status: response.status,
          url: response.config.url,
          data: response.data
        });
        return response;
      },
      (error: AxiosError) => {
        this.logger?.error('HTTP Response Error', {
          status: error.response?.status,
          url: error.config?.url,
          message: error.message,
          data: error.response?.data
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * Generic GET request with retry logic
   */
  async get<T>(endpoint: string): Promise<T> {
    return ErrorHandler.withRetry(
      async () => {
        try {
          const response = await this.axios.get<T>(endpoint);
          return response.data;
        } catch (error) {
          this.handleError(error as AxiosError, 'GET', endpoint);
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000
      },
      this.logger
    );
  }

  /**
   * Generic POST request with retry logic
   */
  async post<T>(endpoint: string, data: any): Promise<T> {
    return ErrorHandler.withRetry(
      async () => {
        try {
          const response = await this.axios.post<T>(endpoint, data);
          return response.data;
        } catch (error) {
          this.handleError(error as AxiosError, 'POST', endpoint);
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000
      },
      this.logger
    );
  }

  /**
   * Get user's KOL subscriptions
   * 
   * Calls GET /get-user-subscriptions endpoint to retrieve
   * the list of KOLs the user is subscribed to.
   * 
   * @returns Array of KOL subscription data
   */
  async getUserSubscriptions(): Promise<KOLSubscription[]> {
    try {
      this.logger?.info('Fetching user subscriptions');
      const response = await this.get<{
        message: string;
        data: KOLSubscription[];
      }>('/api/features/get-user-subscriptions');
      
      this.logger?.info('User subscriptions retrieved', {
        count: response.data?.length || 0
      });
      
      return response.data || [];
    } catch (error) {
      const errorMsg = ErrorHandler.formatErrorMessage(
        'getUserSubscriptions',
        error as Error
      );
      this.logger?.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Get all available KOL wallets
   * 
   * Calls GET /get-kol-wallets endpoint to retrieve
   * all KOL wallet addresses in the system.
   * 
   * @returns Array of KOL wallet addresses (only active KOLs)
   */
  async getAllKOLWallets(): Promise<string[]> {
    try {
      this.logger?.info('Fetching all KOL wallets');
      const kols = await this.getKOLWalletDetails();
      
      // Filter for active KOLs only and extract wallet addresses
      const activeWallets = kols
        .filter(kol => kol.isActive)
        .map(kol => kol.walletAddress);
      
      this.logger?.info('KOL wallets retrieved', {
        total: kols.length,
        active: activeWallets.length
      });
      
      return activeWallets;
    } catch (error) {
      const errorMsg = ErrorHandler.formatErrorMessage(
        'getAllKOLWallets',
        error as Error
      );
      this.logger?.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Get detailed KOL wallet information
   * 
   * Calls GET /get-kol-wallets endpoint to retrieve
   * detailed information about all KOLs in the system.
   * 
   * @returns Array of KOL wallet details
   */
  async getKOLWalletDetails(): Promise<KOLWallet[]> {
    try {
      this.logger?.info('Fetching KOL wallet details');
      const response = await this.get<{
        message: string;
        data: KOLWallet[];
      }>('/api/features/get-kol-wallets');
      
      this.logger?.info('KOL wallet details retrieved', {
        count: response.data?.length || 0
      });
      
      return response.data || [];
    } catch (error) {
      const errorMsg = ErrorHandler.formatErrorMessage(
        'getKOLWalletDetails',
        error as Error
      );
      this.logger?.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Predict trade success probability
   * 
   * Calls POST /predict-trade endpoint with token mint
   * to get ML prediction for trade success.
   * 
   * @param tokenMint - Token mint address to predict
   * @returns Prediction result with confidence score
   */
  async predictTrade(tokenMint: string): Promise<PredictionResult> {
    try {
      this.logger?.info('Requesting trade prediction', { tokenMint });
      
      const response = await this.post<{
        message: string;
        data: PredictionResult[];
      }>('/api/features/predict-trade', { mints: [tokenMint] });
      
      // Extract the first prediction result (we only sent one mint)
      const prediction = response.data?.[0];

      // console.log("PREDICTION RESULT", prediction)
      
      if (!prediction) {
        this.logger?.error('No prediction result returned', { tokenMint });
        throw new Error('No prediction result returned from API');
      }
      
      this.logger?.info('Trade prediction received', {
        tokenMint,
        taskType: prediction.taskType,
        classLabel: prediction.classLabel,
        probability: prediction.probability
      });
      
      return prediction;
    } catch (error) {
      const errorMsg = ErrorHandler.formatErrorMessage(
        'predictTrade',
        error as Error,
        { tokenMint }
      );
      this.logger?.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Perform swap transaction
   * 
   * Calls POST /perform-swap endpoint to execute a buy transaction
   * with the specified parameters and risk management configuration.
   * 
   * Note: Swap operations are NOT retried automatically to prevent duplicate trades.
   * 
   * @param request - Swap request with token, amount, and risk config
   * @returns Swap result with job ID and queue information
   */
  async performSwap(request: SwapRequest): Promise<SwapResult> {
    try {
      this.logger?.info('Executing swap', {
        mint: request.mint,
        tradeType: request.tradeType,
        amount: request.amount,
        watchConfig: request.watchConfig
      });

      // console.log("SWAP REQUEST", request)
      
      // Note: We don't use ErrorHandler.withRetry here because we don't want
      // to retry swap operations automatically (could cause duplicate trades)
      const response = await this.axios.post<{
        message: string;
        data: {
          success: boolean;
          results: Array<{
            success: boolean;
            jobId?: string;
            message: string;
            tradeIndex: number;
            queuePosition?: number;
          }>;
          message: string;
          totalQueued?: number;
        };
      }>('/api/features/perform-swap', request);

      // console.log("SWAP RESPONSE", response.data)
      
      // Extract the first result from the batch response
      const firstResult = response.data.data?.results?.[0];
      
      if (!firstResult) {
        this.logger?.error('No results in swap response', {
          mint: request.mint,
          responseData: response.data
        });
        return {
          success: false,
          error: 'No results returned from swap endpoint'
        };
      }
      
      const result: SwapResult = {
        success: firstResult.success,
        jobId: firstResult.jobId,
        message: firstResult.message,
        queuePosition: firstResult.queuePosition,
        totalQueued: response.data.data?.totalQueued,
        error: !firstResult.success ? firstResult.message : undefined
      };

      // console.log("SWAP RESULT", result)
      
      if (result.success) {
        this.logger?.info('Swap queued successfully', {
          mint: request.mint,
          jobId: result.jobId,
          queuePosition: result.queuePosition,
          totalQueued: result.totalQueued
        });
      } else {
        this.logger?.warn('Swap execution failed', {
          mint: request.mint,
          error: result.error
        });
      }
      
      return result;
    } catch (error) {
      const errorMsg = ErrorHandler.formatErrorMessage(
        'performSwap',
        error as Error,
        { mint: request.mint, amount: request.amount }
      );
      this.logger?.error(errorMsg);
      
      return {
        success: false,
        error: errorMsg
      };
    }
  }

  /**
   * Handle HTTP errors with detailed logging
   */
  private handleError(error: AxiosError, method: string, endpoint: string): void {
    if (error.response) {
      // Server responded with error status
      this.logger?.error(`HTTP ${method} ${endpoint} failed`, {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    } else if (error.request) {
      // Request made but no response received
      this.logger?.error(`HTTP ${method} ${endpoint} - No response`, {
        message: error.message
      });
    } else {
      // Error setting up request
      this.logger?.error(`HTTP ${method} ${endpoint} - Request setup failed`, {
        message: error.message
      });
    }
  }
}
