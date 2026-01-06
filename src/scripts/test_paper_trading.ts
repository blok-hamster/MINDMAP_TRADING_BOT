
import { AgentLedgerTools } from '../services/SolanaTxService';
import { PaperWalletService } from '../services/PaperWalletService';
import { config } from 'dotenv';
import process from 'process';

config();

// Force simulation mode for this test
process.env.SIMULATING = 'true';
process.env.PAPER_TRADING_INITIAL_SOL = '100'; // Start rich for testing

async function testPaperTrading() {
    console.log('🚀 Starting Paper Trading Verification...');

    // 1. Setup
    const ledgerTools = new AgentLedgerTools();
    const paperWallet = new PaperWalletService(); 
    
    // Reset wallet for clean state
    await paperWallet.resetWallet(100);

    const initialBalances = await paperWallet.getAllBalances();
    console.log('💰 Initial Balances:', initialBalances);

    if (initialBalances['SOL'] !== 100) {
        throw new Error(`Initial SOL balance incorrect. Expected 100, got ${initialBalances['SOL']}`);
    }

    // 2. Mock BUY
    const testMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // Bonk
    const buyAmount = 1.5; // SOL

    console.log(`\n🛍️ Executing BUY of ${buyAmount} SOL for ${testMint}...`);
    const buyResult = await ledgerTools.performSwap({
        amount: buyAmount,
        action: 'buy',
        mint: testMint,
        watchConfig: {
            takeProfitPercentage: 20,
            stopLossPercentage: 10
        }
    });

    if (!buyResult.success) {
        throw new Error(`Buy failed: ${buyResult.message}`);
    }
    console.log('✅ Buy Successful:', buyResult.message);

    const postBuyBalances = await paperWallet.getAllBalances();
    console.log('💰 Post-Buy Balances:', postBuyBalances);

    // Verify SOL deduction (approximate due to fees)
    if (postBuyBalances['SOL'] >= 100) {
        throw new Error('SOL balance did not decrease after buy');
    }
    if (!postBuyBalances[testMint] || postBuyBalances[testMint] <= 0) {
        throw new Error('Token balance verification failed');
    }

    // 3. Mock SELL
    // Sell half the tokens
    const sellAmount = postBuyBalances[testMint] / 2;
    console.log(`\n📉 Executing SELL of ${sellAmount} tokens...`);

    const sellResult = await ledgerTools.performSwap({
        amount: sellAmount,
        action: 'sell',
        mint: testMint
    });

    if (!sellResult.success) {
        throw new Error(`Sell failed: ${sellResult.message}`);
    }
    console.log('✅ Sell Successful:', sellResult.message);

    const postSellBalances = await paperWallet.getAllBalances();
    console.log('💰 Post-Sell Balances:', postSellBalances);

    // Verify Token deduction
    // Use a small epsilon for floating point comparison if needed, but direct comparison usually works for simple subtraction
    if (postSellBalances[testMint] >= postBuyBalances[testMint]) {
         throw new Error('Token balance did not decrease after sell');
    }
    
    // Verify SOL increase
    if (postSellBalances['SOL'] <= postBuyBalances['SOL']) {
        throw new Error('SOL balance did not increase after sell');
    }

    console.log('\n🎉 Paper Trading Verification Passed!');
    process.exit(0);
}

testPaperTrading().catch(err => {
    console.error('❌ Test Failed:', err);
    process.exit(1);
});
