import * as fs from 'fs';
import * as path from 'path';
import { BotConfig, FilterCriteria, RiskManagementConfig } from '../types';
import { config } from 'dotenv'
config()

/**
 * ConfigManager handles loading, validating, and managing bot configuration
 * from multiple sources (environment variables and config file)
 */
export class ConfigManager {
  private config: BotConfig | null = null;

  /**
   * Load configuration from environment variables and config file
   * Environment variables take precedence over config file
   */
  public load(): BotConfig {
    const envConfig = this.loadFromEnv();
    const fileConfig = this.loadFromFile();
    
    this.config = this.mergeConfigs(envConfig, fileConfig);
    
    if (!this.validate()) {
      throw new Error('Configuration validation failed');
    }
    
    return this.config;
  }

  /**
   * Validate the loaded configuration
   */
  public validate(): boolean {
    if (!this.config) {
      console.error('Configuration not loaded');
      return false;
    }

    const errors: string[] = [];

    // Validate API configuration
    if (!this.config.api.serverUrl) {
      errors.push('API server URL is required');
    }
    if (!this.config.api.apiKey) {
      errors.push('API key is required');
    }

    // Validate Redis configuration
    if (!this.config.redis.url) {
      errors.push('Redis URL is required');
    }

    // Validate monitoring configuration
    if (!['all', 'subscribed'].includes(this.config.monitoring.mode)) {
      errors.push('Monitoring mode must be "all" or "subscribed"');
    }

    // Validate filter criteria
    if (this.config.filter.minTradeVolume < 0) {
      errors.push('Minimum trade volume must be non-negative');
    }
    if (this.config.filter.minConnectedKOLs < 0) {
      errors.push('Minimum connected KOLs must be non-negative');
    }
    if (this.config.filter.minInfluenceScore < 0 || this.config.filter.minInfluenceScore > 100) {
      errors.push('Minimum influence score must be between 0 and 100');
    }
    if (this.config.filter.minTotalTrades < 0) {
      errors.push('Minimum total trades must be non-negative');
    }

    // Validate risk management
    if (this.config.risk.takeProfitPercentage < 1 || this.config.risk.takeProfitPercentage > 1000) {
      errors.push('Take profit percentage must be between 1 and 1000');
    }
    if (this.config.risk.stopLossPercentage < 1 || this.config.risk.stopLossPercentage > 100) {
      errors.push('Stop loss percentage must be between 1 and 100');
    }

    // Validate trading configuration
    if (this.config.trading.buyAmount <= 0) {
      errors.push('Buy amount must be greater than zero');
    }

    // Validate logging configuration
    if (!['debug', 'info', 'warn', 'error'].includes(this.config.logging.level)) {
      errors.push('Log level must be one of: debug, info, warn, error');
    }

    if (errors.length > 0) {
      console.error('Configuration validation errors:');
      errors.forEach(error => console.error(`  - ${error}`));
      return false;
    }

    // Log warnings for values outside recommended ranges
    this.logWarnings();

    return true;
  }

  /**
   * Reload configuration (useful for hot-reloading)
   */
  public reload(): void {
    this.load();
  }

  /**
   * Get a specific configuration value by key path
   */
  public get<T>(key: string): T {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }

    const keys = key.split('.');
    let value: any = this.config;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        throw new Error(`Configuration key not found: ${key}`);
      }
    }

    return value as T;
  }

  /**
   * Get the complete configuration
   */
  public getConfig(): BotConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }
    return this.config;
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnv(): Partial<BotConfig> {
    const config: Partial<BotConfig> = {};

    // API configuration
    if (process.env.API_SERVER_URL || process.env.API_KEY) {
      config.api = {
        serverUrl: process.env.API_SERVER_URL || '',
        apiKey: process.env.API_KEY || '',
      };
    }

    // Redis configuration
    if (process.env.REDIS_URL) {
      config.redis = {
        url: process.env.REDIS_URL,
      };
    }

    // Monitoring configuration
    if (process.env.MONITORING_MODE) {
      config.monitoring = {
        mode: process.env.MONITORING_MODE as 'all' | 'subscribed',
      };
    }

    // Filter configuration
    const filterConfig: Partial<FilterCriteria> = {};
    if (process.env.MIN_TRADE_VOLUME) {
      filterConfig.minTradeVolume = parseFloat(process.env.MIN_TRADE_VOLUME);
    }
    if (process.env.MIN_CONNECTED_KOLS) {
      filterConfig.minConnectedKOLs = parseInt(process.env.MIN_CONNECTED_KOLS, 10);
    }
    if (process.env.MIN_INFLUENCE_SCORE) {
      filterConfig.minInfluenceScore = parseFloat(process.env.MIN_INFLUENCE_SCORE);
    }
    if (process.env.MIN_TOTAL_TRADES) {
      filterConfig.minTotalTrades = parseInt(process.env.MIN_TOTAL_TRADES, 10);
    }
    if (Object.keys(filterConfig).length > 0) {
      config.filter = filterConfig as FilterCriteria;
    }

    // Risk management configuration
    const riskConfig: Partial<RiskManagementConfig> = {};
    if (process.env.TAKE_PROFIT_PERCENTAGE) {
      riskConfig.takeProfitPercentage = parseFloat(process.env.TAKE_PROFIT_PERCENTAGE);
    }
    if (process.env.STOP_LOSS_PERCENTAGE) {
      riskConfig.stopLossPercentage = parseFloat(process.env.STOP_LOSS_PERCENTAGE);
    }
    if (process.env.TRAILING_STOP_ENABLED) {
      riskConfig.trailingStopEnabled = process.env.TRAILING_STOP_ENABLED === 'true';
    }
    if (Object.keys(riskConfig).length > 0) {
      config.risk = riskConfig as RiskManagementConfig;
    }

    // Trading configuration
    if (process.env.BUY_AMOUNT) {
      config.trading = {
        buyAmount: parseFloat(process.env.BUY_AMOUNT),
      };
    }

    // Logging configuration
    if (process.env.LOG_LEVEL) {
      config.logging = {
        level: process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error',
      };
    }

    return config;
  }

  /**
   * Load configuration from config.json file
   */
  private loadFromFile(): Partial<BotConfig> {
    const configPath = path.join(process.cwd(), 'config.json');

    if (!fs.existsSync(configPath)) {
      console.warn('config.json not found, using environment variables only');
      return {};
    }

    try {
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(fileContent);
      return config;
    } catch (error) {
      console.error('Error reading config.json:', error);
      return {};
    }
  }

  /**
   * Merge configurations with proper precedence (env > file)
   */
  private mergeConfigs(
    envConfig: Partial<BotConfig>,
    fileConfig: Partial<BotConfig>
  ): BotConfig {
    // Start with default configuration
    const defaultConfig: BotConfig = {
      api: {
        serverUrl: 'http://localhost:3000',
        apiKey: '',
      },
      redis: {
        url: 'redis://localhost:6379',
      },
      monitoring: {
        mode: 'all',
      },
      filter: {
        minTradeVolume: 10,
        minConnectedKOLs: 2,
        minInfluenceScore: 50,
        minTotalTrades: 5,
      },
      risk: {
        takeProfitPercentage: 50,
        stopLossPercentage: 20,
        trailingStopEnabled: true,
      },
      trading: {
        buyAmount: 0.1,
      },
      logging: {
        level: 'info',
      },
    };

    // Merge file config over defaults
    const merged = this.deepMerge(defaultConfig, fileConfig);

    // Merge env config over file config (env takes precedence)
    return this.deepMerge(merged, envConfig);
  }

  /**
   * Deep merge two objects
   */
  private deepMerge<T>(target: T, source: Partial<T>): T {
    const result = { ...target };

    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        const sourceValue = source[key];
        const targetValue = result[key];

        if (
          sourceValue &&
          typeof sourceValue === 'object' &&
          !Array.isArray(sourceValue) &&
          targetValue &&
          typeof targetValue === 'object' &&
          !Array.isArray(targetValue)
        ) {
          result[key] = this.deepMerge(targetValue, sourceValue as any);
        } else if (sourceValue !== undefined) {
          result[key] = sourceValue as any;
        }
      }
    }

    return result;
  }

  /**
   * Log warnings for configuration values outside recommended ranges
   */
  private logWarnings(): void {
    if (!this.config) return;

    const warnings: string[] = [];

    // Check filter criteria
    if (this.config.filter.minTradeVolume < 100) {
      warnings.push('Minimum trade volume is very low, may result in many false positives');
    }
    if (this.config.filter.minConnectedKOLs < 2) {
      warnings.push('Minimum connected KOLs is very low, consider increasing for better quality');
    }
    if (this.config.filter.minInfluenceScore < 30) {
      warnings.push('Minimum influence score is low, may include low-quality KOLs');
    }

    // Check risk management
    if (this.config.risk.takeProfitPercentage < 20) {
      warnings.push('Take profit percentage is low, may result in small gains');
    }
    if (this.config.risk.stopLossPercentage > 50) {
      warnings.push('Stop loss percentage is high, may result in large losses');
    }

    // Check trading configuration
    if (this.config.trading.buyAmount > 1) {
      warnings.push('Buy amount is high, ensure you have sufficient balance');
    }

    if (warnings.length > 0) {
      console.warn('Configuration warnings:');
      warnings.forEach(warning => console.warn(`  - ${warning}`));
    }
  }
}
