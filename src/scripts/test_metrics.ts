
import { config } from 'dotenv';
import path from 'path';

// Load env from root of trading_bot (2 levels up)
config({ path: path.resolve(__dirname, '../../.env') });

import { getTokenMarketCapInUsd, getTokenLiquidityInUsd } from '../utils/solanaUtils';
import { SolanaPriceSDK } from '../utils/onchainPrice';

async function testMetrics() {
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!rpcUrl) {
        console.error("❌ SOLANA_RPC_URL not found in .env");
        return;
    }

    console.log(`Using RPC: ${rpcUrl}`);

    // multiple tokens to test
    const tokens = [
        // Mint from logs (Active PumpSwap/Bonding Curve)
        'CspBykmxtguVwCeZ7foZYo2yTnfBBE6Jcmke87ofUy51', 
        // Example: POPCAT (Active Raydium) - if this mint is correct, otherwise random
        // '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' // POPCAT
    ];

    const sdk = new SolanaPriceSDK(rpcUrl);

    for (const mint of tokens) {
        console.log(`\n--- Testing Token: ${mint} ---`);

        try {
            console.log("1. Fetching Market Cap...");
            const mcap = await getTokenMarketCapInUsd(mint, rpcUrl);
            console.log(`   💰 Market Cap: $${mcap?.toLocaleString() ?? 'FAILED'}`);

            console.log("2. Fetching Price Data for Liquidity...");
            const priceData = await sdk.getTokenPrice(mint);
            
            if (priceData) {
                console.log(`   🏷️  Price (SOL): ${priceData.price}`);
                console.log(`   💧 Raw Liquidity (Units): ${priceData.liquidity.toLocaleString()}`);
                console.log(`   🏦 Quote Pair: ${priceData.pair} (${priceData.source})`);

                const liqUsd = await getTokenLiquidityInUsd(priceData);
                console.log(`   💧 Liquidity (USD): $${liqUsd.toLocaleString()}`);
            } else {
                console.log("   ❌ Failed to get price data (cannot calc liquidity)");
            }

        } catch (e) {
            console.error("   ❌ Error during test:", e);
        }
    }
}

testMetrics();
