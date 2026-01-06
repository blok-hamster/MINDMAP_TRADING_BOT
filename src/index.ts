/**
 * KOL Mindmap Trading Bot - Main Entry Point
 * 
 * This is the main entry point for the trading bot application.
 * It initializes all services, creates the bot engine, and handles
 * graceful shutdown on process signals.
 */

import 'dotenv/config';
import { ConfigManager } from './config/ConfigManager';
import { BotCoreEngine } from './core/BotCoreEngine';
import { MindmapFilterEngine } from './core/MindmapFilterEngine';
import {
  LoggerService,
  RedisCacheService,
  ApiHttpClient,
  WebSocketManager,
  MLPredictionService,
  TradeExecutor,
  TradeHistoryService,
  AgentLedgerTools,
  BatchPriceService
} from './services';
import { ApiServer } from './server/ApiServer';


/**
 * Main application bootstrap function
 * 
 * Loads configuration, initializes all services with dependency injection,
 * creates the bot engine, and starts the bot.
 */
async function main(): Promise<void> {
  let bot: BotCoreEngine | null = null;

  try {
    console.log('🚀 KOL Mindmap Trading Bot - Starting...\n');

    // Step 1: Load and validate configuration
    console.log('📋 Loading configuration...');
    const configManager = new ConfigManager();
    const config = configManager.load();
    console.log('✅ Configuration loaded and validated\n');

    // Step 2: Initialize logger service
    console.log('📝 Initializing logger...');
    const logger = new LoggerService(config.logging);
    logger.info('Logger initialized', { level: config.logging.level });
    console.log('✅ Logger initialized\n');

    // Step 3: Initialize Redis cache service
    console.log('💾 Initializing Redis cache service...');
    const cacheService = new RedisCacheService(config.redis.url);
    logger.info('Redis cache service created', { url: config.redis.url });
    console.log('✅ Redis cache service initialized\n');

    // Step 4: Initialize HTTP client
    console.log('🌐 Initializing HTTP client...');
    const httpClient = new ApiHttpClient(
      {
        baseUrl: config.api.serverUrl,
        apiKey: config.api.apiKey,
        timeout: 30000,
        retries: 3
      },
      logger
    );
    logger.info('HTTP client initialized', { baseUrl: config.api.serverUrl });
    console.log('✅ HTTP client initialized\n');

    // Step 5: Initialize WebSocket manager
    console.log('🔌 Initializing WebSocket manager...');
    const wsManager = new WebSocketManager({
      serverUrl: config.api.serverUrl,
      apiKey: config.api.apiKey,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000
    });
    logger.info('WebSocket manager initialized', { serverUrl: config.api.serverUrl });
    console.log('✅ WebSocket manager initialized\n');

    // Step 6a: Initialize Batch Price Service (Reader/On-Demand)
    console.log('📉 Initializing Batch Price Service...');
    const batchPriceService = new BatchPriceService(process.env.SOLANA_RPC_URL!);
    console.log('✅ Batch Price Service initialized\n');

    // Step 6: Initialize filter engine
    console.log('🔍 Initializing filter engine...');
    const filterEngine = new MindmapFilterEngine(config.filter, batchPriceService);
    logger.info('Filter engine initialized', { criteria: config.filter });
    console.log('✅ Filter engine initialized\n');

    // Step 7: Initialize ML prediction service
    console.log('🤖 Initializing ML prediction service...');
    const predictionService = new MLPredictionService(httpClient, logger);
    logger.info('ML prediction service initialized');
    console.log('✅ ML prediction service initialized\n');

    // Step 8: Initialize trade executor
    console.log('💰 Initializing trade executor...');
    const ledgerTools = new AgentLedgerTools(logger); // Config loaded from env
    const tradeExecutor = new TradeExecutor(cacheService, ledgerTools, logger);
    logger.info('Trade executor initialized');
    console.log('✅ Trade executor initialized\n');

    // Step 9: Create bot core engine with all dependencies
    console.log('🤖 Creating bot core engine...');
    bot = new BotCoreEngine({
      wsManager,
      cacheService,
      httpClient,
      filterEngine,
      predictionService,
      tradeExecutor,
      config,
      logger
    });
    logger.info('Bot core engine created');
    console.log('✅ Bot core engine created\n');

    // Step 9a: Initialize Trade Watch Service
    console.log('👀 Initializing Trade Watcher Service...');
    
    // Initialize dependencies for Watcher
    // Initialize dependencies for Watcher
    const tradeHistoryService = new TradeHistoryService(config.redis.url);
    
    // Initialize API Server (which creates WebSocket Server)
    const apiServer = new ApiServer(tradeHistoryService, config);
    apiServer.start(); // Start Express + Socket.IO

    // Inject WS Server into TradeHistoryService
    // We need to cast internal property access or add a public setter
    // For now, simpler to reconstruct TradeHistoryService with WS or modify constructor usage
    // Re-initializing TradeHistoryService with WS Server:
    // (Note: In a cleaner DI system we'd do this differently, but here we just re-instantiate or modify)
    
    // Let's modify TradeHistoryService constructor call above instead?
    // Actually, ApiServer CREATES the WS server. So we need to:
    // 1. Create ApiServer first? No, ApiServer needs TradeHistoryService. Circular dependency?
    // ApiServer needs TradeHistoryService for GET requests.
    // TradeHistoryService needs WebSocketServer for emitting.
    // WebSocketServer is property of ApiServer.
    
    // Solution:
    // 1. Create TradeHistoryService (no WS yet).
    // 2. Create ApiServer (passes TradeHistoryService).
    // 3. Inject ApiServer.wsServer into TradeHistoryService.
    (tradeHistoryService as any).wsServer = apiServer.wsServer; // Quick fix for property injection

    (tradeHistoryService as any).wsServer = apiServer.wsServer; // Quick fix for property injection

    // --- WORKER THREAD OPTIMIZATION ---
    console.log('🧵 Spawning Worker Threads...');

    // 1. Price Monitor Worker
    const { Worker } = await import('worker_threads');
    const path = await import('path');
    
    // Determine environment (TS vs JS)
    const isTs = __filename.endsWith('.ts');
    const workerExt = isTs ? '.ts' : '.js';
    const workerExecArgv = isTs ? ['-r', 'ts-node/register'] : undefined;

    const priceWorkerPath = path.join(__dirname, `workers/priceMonitor${workerExt}`);
    const priceWorker = new Worker(priceWorkerPath, { execArgv: workerExecArgv });
    
    priceWorker.on('error', (err) => console.error('❌ Price Worker Error:', err));
    priceWorker.on('exit', (code) => console.log(`Price Worker exited with code ${code}`));
    console.log(`✅ Price Monitor Worker spawned (${workerExt})`);

    // 2. Trade Watcher Worker
    const watcherWorkerPath = path.join(__dirname, `workers/tradeWatcher${workerExt}`);
    const watcherWorker = new Worker(watcherWorkerPath, { execArgv: workerExecArgv });

    // Provide Main Thread WebSocket Bridge for Worker Events
    watcherWorker.on('message', (msg) => {
        if (msg.type === 'trade_update') {
            apiServer.wsServer.broadcastTradeUpdate(msg.data);
        } else if (msg.type === 'price_update') {
            apiServer.wsServer.broadcastPriceUpdate(msg.data);
        }
    });

    watcherWorker.on('error', (err) => console.error('❌ Trade Watcher Worker Error:', err));
    watcherWorker.on('exit', (code) => console.log(`Trade Watcher Worker exited with code ${code}`));
    console.log('✅ Trade Watcher Worker spawned\n');

    // Store workers globally for cleanup (or pass to shutdown handler)
    (global as any).botWorkers = [priceWorker, watcherWorker];

    // Note: We no longer instantiate local BatchPriceService or TradeWatcherService
    // const batchPriceService = new BatchPriceService(process.env.SOLANA_RPC_URL!);
    // await batchPriceService.startMonitoring(); 
    // const tradeWatcherService = new TradeWatcherService(...);
    // tradeWatcherService.start();

    // Step 10: Setup signal handlers for graceful shutdown
    setupSignalHandlers(bot, logger);

    // Step 11: Start the bot
    console.log('🎯 Starting bot...\n');
    await bot.start();

    logger.info('🎉 Bot started successfully and is now running');
    console.log('\n✅ Bot is running! Press Ctrl+C to stop.\n');

  } catch (error) {
    console.error('\n❌ Failed to start bot:', error);
    
    // Attempt graceful shutdown if bot was created
    if (bot) {
      try {
        await bot.stop();
      } catch (stopError) {
        console.error('Error during emergency shutdown:', stopError);
      }
    }

    // Exit with error code
    process.exit(1);
  }
}

/**
 * Setup signal handlers for graceful shutdown
 * 
 * Listens for SIGINT, SIGTERM, and SIGQUIT signals and initiates
 * graceful shutdown of the bot when received.
 * 
 * @param bot - Bot core engine instance
 * @param logger - Logger instance for logging shutdown events
 */
function setupSignalHandlers(bot: BotCoreEngine, logger: any): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

  signals.forEach((signal) => {
    process.on(signal, async () => {
      console.log(`\n\n🛑 Received ${signal} signal, initiating graceful shutdown...\n`);
      logger.info(`Received ${signal} signal, shutting down gracefully`);

      try {
        // Call bot.stop() for graceful shutdown
        await bot.stop();

        // Stop Workers
        if ((global as any).botWorkers) {
            console.log('🛑 Stopping workers...');
            (global as any).botWorkers.forEach((w: any) => w.postMessage('STOP'));
        }

        logger.info('✅ Graceful shutdown completed');
        console.log('✅ Shutdown completed successfully\n');

        // Exit process with success code
        process.exit(0);
      } catch (error) {
        logger.error('Error during graceful shutdown', error as Error);
        console.error('❌ Error during shutdown:', error);

        // Force exit with error code
        process.exit(1);
      }
    });
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('\n❌ Uncaught Exception:', error);
    logger.error('Uncaught exception', error);
    
    // Attempt graceful shutdown
    bot.stop()
      .catch((stopError) => {
        console.error('Error during emergency shutdown:', stopError);
      })
      .finally(() => {
        process.exit(1);
      });
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ Unhandled Rejection at:', promise, 'reason:', reason);
    logger.error('Unhandled promise rejection', reason as Error);
    
    // Attempt graceful shutdown
    bot.stop()
      .catch((stopError) => {
        console.error('Error during emergency shutdown:', stopError);
      })
      .finally(() => {
        process.exit(1);
      });
  });

  logger.info('Signal handlers configured', { signals });
  console.log('✅ Signal handlers configured for graceful shutdown\n');
}

// Start the application
main().catch((error) => {
  console.error('Fatal error in main:', error);
  process.exit(1);
});
