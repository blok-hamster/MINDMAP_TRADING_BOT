
import { PaperWalletService } from '../services/PaperWalletService';
import { TradeHistoryService } from '../services/TradeHistoryService';
import { RedisCacheService } from '../services/CacheService';
import { config } from 'dotenv';
import { LoggerService } from '../services/LoggerService';

// Load environment variables
config();

async function resetPaperTrading() {
  console.log('🗑️  Starting Paper Trading Reset...');
  
  const logger = new LoggerService({
     level: 'info'
  });

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  // Initialize services
  const paperWallet = new PaperWalletService(redisUrl);
  const tradeHistory = new TradeHistoryService(redisUrl);
  const cacheService = new RedisCacheService(redisUrl, logger);

  try {
    // 1. Reset Paper Wallet Balance
    console.log('\n--- 💰 Resetting Paper Wallet ---');
    const initialSol = process.env.PAPER_TRADING_INITIAL_SOL ? parseFloat(process.env.PAPER_TRADING_INITIAL_SOL) : 10;
    await paperWallet.resetWallet(initialSol);
    console.log(`✅ Paper wallet reset to ${initialSol} SOL`);

    // 2. Clear Trade History
    console.log('\n--- 📜 Clearing Trade History ---');
    await tradeHistory.clearAll();
    console.log('✅ Trade history cleared');

    // 3. Reset Trading State (Processed tokens, etc.)
    console.log('\n--- 🧠 Clearing Bot Cache State ---');
    await cacheService.connect(); // Cache service needs explicit connect
    await cacheService.resetTradingState();
    console.log('✅ Bot cache state reset');

    console.log('\n✨ Paper trading environment successfully reset!');

  } catch (error) {
    console.error('\n❌ Error during reset:', error);
    process.exit(1);
  } finally {
    // Cleanup connections
    await cacheService.disconnect();
    await tradeHistory.close();
    // PaperWalletService manages its own connection but doesn't expose close directly in the basic version, 
    // but the script exit will handle it.
    process.exit(0);
  }
}

// Run the reset
resetPaperTrading();
