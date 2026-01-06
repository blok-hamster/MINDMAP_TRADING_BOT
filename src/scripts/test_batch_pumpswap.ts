
import { BatchPriceService } from '../services/BatchPriceService';
import { config } from 'dotenv';
import { createClient } from 'redis';

config();

// Use the token from the user's log (which was on PumpSwap)
const PUMPSWAP_MINT = '3JSpVpVMgMEBznMZm1rmcqKVhCuwEHGF6rVHcY1ZPcDa';

async function test() {
    console.log('🧪 Starting Batch PumpSwap Test...');
    
    // Setup Redis to clear cache
    const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    await redis.connect();
    
    // Clear cache for clean test
    await redis.del(`pumpswap_vaults:${PUMPSWAP_MINT}`);
    await redis.del(`price_source:${PUMPSWAP_MINT}`);
    console.log('🧹 Cleared Redis cache for PumpSwap Token');

    const service = new BatchPriceService(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'); 

    // 1. Cold Start (Discovery)
    console.log('\n--- Test 1: Cold Start (Discovery) ---');
    const start1 = Date.now();
    const res1 = await service.fetchSecondaryPrices([PUMPSWAP_MINT]);
    const duration1 = Date.now() - start1;
    
    console.log(`⏱️ Duration: ${duration1}ms`);
    console.log('Result:', res1);

    // Check Cache
    const cachedVaults = await redis.get(`pumpswap_vaults:${PUMPSWAP_MINT}`);
    console.log(`💾 Cache present: ${!!cachedVaults}`);
    if (!cachedVaults) {
        console.error('❌ FAILED: Vaults were not cached after discovery!');
        process.exit(1);
    }

    // 2. Warm Start (Fast Path)
    console.log('\n--- Test 2: Warm Start (Fast Path) ---');
    const start2 = Date.now();
    const res2 = await service.fetchSecondaryPrices([PUMPSWAP_MINT]);
    const duration2 = Date.now() - start2;
    
    console.log(`⏱️ Duration: ${duration2}ms`);
    console.log('Result:', res2);

    if (duration2 > 500) {
        console.error('❌ FAILED: Warm start took too long! Batching might be broken.');
    } else {
        console.log('✅ PASSED: Warm start was fast!');
    }

    // Cleanup
    await redis.disconnect();
    process.exit(0);
}

test().catch(console.error);
