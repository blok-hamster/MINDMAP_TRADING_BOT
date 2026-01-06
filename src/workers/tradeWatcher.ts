import 'dotenv/config';
import { parentPort, threadId } from 'worker_threads';
import { TradeWatcherService } from '../services/TradeWatcherService';
import { TradeHistoryService } from '../services/TradeHistoryService';
import { BatchPriceService } from '../services/BatchPriceService';
import { AgentLedgerTools } from '../services/SolanaTxService';

import { LoggerService } from '../services/LoggerService';

// Ensure env vars are available
if (!process.env.REDIS_URL || !process.env.SOLANA_RPC_URL) {
    console.error(`❌ Worker [TradeWatcher] (Thread ${threadId}): Missing REDIS_URL or SOLANA_RPC_URL`);
    process.exit(1);
}

const logger = new LoggerService({ level: 'info' });
logger.info(`🚀 Worker [TradeWatcher]: Starting on Thread ${threadId}...`);

try {
    // 1. Initialize Dependencies
    const tradeHistoryService = new TradeHistoryService(process.env.REDIS_URL);
    
    // Note: We create BatchPriceService here ONLY to access helper methods 
    // (addTokenInterest, getCachedPrice). We do NOT call startMonitoring().
    // The actual price fetching happens in the priceMonitor worker.
    const batchPriceService = new BatchPriceService(process.env.SOLANA_RPC_URL);

    const ledgerTools = new AgentLedgerTools(logger);

    // 2. Initialize Service
    const tradeWatcherService = new TradeWatcherService(
        tradeHistoryService,
        batchPriceService,
        ledgerTools,
        logger
    );

    // 3. Start Service
    tradeWatcherService.start();

    // 4. Relay Events to Main Thread
    tradeHistoryService.on('trade_update', (trade) => {
        parentPort?.postMessage({ type: 'trade_update', data: trade });
    });

    tradeHistoryService.on('price_update', (update) => {
        parentPort?.postMessage({ type: 'price_update', data: update });
    });

    // 5. Handle Termination
    parentPort?.on('message', (message) => {
        if (message === 'STOP') {
            console.log('🛑 Worker [TradeWatcher]: Stopping...');
            tradeWatcherService.stop();
            process.exit(0);
        }
    });

} catch (error) {
    console.error('❌ Worker [TradeWatcher]: Fatal error', error);
    process.exit(1);
}
