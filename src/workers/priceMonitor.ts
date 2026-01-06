import 'dotenv/config';
import { parentPort, threadId } from 'worker_threads';
import { BatchPriceService } from '../services/BatchPriceService';

// Ensure RPC URL is available
if (!process.env.SOLANA_RPC_URL) {
    console.error(`❌ Worker [PriceMonitor] (Thread ${threadId}): SOLANA_RPC_URL not set`);
    process.exit(1);
}

console.log(`🚀 Worker [PriceMonitor]: Starting on Thread ${threadId}...`);

try {
    const batchPriceService = new BatchPriceService(process.env.SOLANA_RPC_URL);

    // Start the monitoring loop
    batchPriceService.startMonitoring();

    // Listen for messages from main thread
    parentPort?.on('message', async (message) => {
        if (message === 'STOP') {
            console.log('🛑 Worker [PriceMonitor]: Stopping...');
            // We don't have a clean stop method exposed on the instance, 
            // but the process exit handles it. 
            // Ideally we'd call batchPriceService.stop() if it existed.
            process.exit(0);
        }
    });

} catch (error) {
    console.error('❌ Worker [PriceMonitor]: Fatal error', error);
    process.exit(1);
}
