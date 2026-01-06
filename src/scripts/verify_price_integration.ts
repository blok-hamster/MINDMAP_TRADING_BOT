
// import { Connection } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import path from 'path';
import { SolanaPriceSDK } from '../utils/onchainPrice';
import { pumpPortalService } from '../services/PumpPortalPriceService';

// Load env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT = process.argv[2] || '6YxpYE2aHPF7PqPuH8J2J66vQPMwzyhMva8YVDzVbonk';

async function main() {
    console.log('Initializing SDK...');
    const sdk = new SolanaPriceSDK(RPC_URL);

    console.log(`\nWaiting 5 seconds for WebSocket to connect and subscribe...`);
    // Pre-subscribe manually to ensure it's ready (though SDK does it too)
    pumpPortalService.subscribeToToken(TOKEN_MINT);
    
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log(`\nFetching Price for: ${TOKEN_MINT}`);
    const price = await sdk.getTokenPrice(TOKEN_MINT);

    if (price) {
        console.log('\n✅ Price Found!');
        console.log(JSON.stringify(price, null, 2));

        if (price.source === 'LaunchLab' || price.source === 'Raydium') {
            console.log('\n--- Debug Info ---');
            console.log('Pool/Account Data:', price.poolData);
        }
    } else {
        console.log('\n❌ Price Not Found (Yet). Token might be inactive or WebSocket has no data.');
        console.log('Ensure the token is actively trading on PumpPortal.');
    } // Wait a bit more to see if updates come in
    
    process.exit(0);
}

main().catch(console.error);
