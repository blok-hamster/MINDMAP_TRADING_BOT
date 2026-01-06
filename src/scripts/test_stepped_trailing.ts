
import { TradeWatcherService } from '../services/TradeWatcherService';
import { TradeHistoryService } from '../services/TradeHistoryService';
import { TradeHistoryEntry } from '../services/TradeHistoryService';

// Mock Services
const mockTradeService = {
  updateTrade: async (t: any) => console.log(`[DB] Updated Trade ${t.id}`),
  addTrade: async (t: any) => console.log(`[DB] Added Trade ${t.id}`)
} as unknown as TradeHistoryService;


// Mock BatchPriceService
const mockBatchService = {
  addTokenInterest: async () => {},
  getCachedPrice: async () => null,
  hasPriceError: async () => false,
} as any;

const mockLedgerTools = {} as any;

const watcher = new TradeWatcherService(mockTradeService, mockBatchService, mockLedgerTools);

// Access private method helper
const updateTrailingStopLoss = (trade: TradeHistoryEntry, price: number) => {
    return (watcher as any).updateTrailingStopLoss(trade, price);
};

async function testSteppedTrailing() {
    console.log('🧪 Starting Stepped Trailing Test...');

    // 1. Setup Trade
    const trade: TradeHistoryEntry = {
        id: 'test_trade_1',
        agentId: 'test_agent', // Required
        tokenMint: 'TEST_MINT',
        createdAt: new Date(), // Required
        entryPrice: 100,
        entryAmount: 100, // 100 tokens
        entryValue: 100 * 100, // 100 * 100 = $10000
        openedAt: new Date(),
        updatedAt: new Date(),
        status: 'open', // Fixed Enum
        sellConditions: {
            takeProfitPercentage: 50,
            trailingStopPercentage: 10,
            trailingStopActivated: false
        }
    };

    console.log('--- Initial State ---');
    console.log(`Entry: $${trade.entryPrice}, TP: 50%, Trailing: 10%`);

    // 2. Pump to $140 (+40%)
    console.log('\n--- Pump to $140 ---');
    updateTrailingStopLoss(trade, 140);
    console.log(`Activated: ${trade.sellConditions.trailingStopActivated}`);
    if (trade.sellConditions.trailingStopActivated) console.error('❌ Failed: Activated too early!');

    // 3. Pump to $150 (+50%) -> ACTIVATION
    console.log('\n--- Pump to $150 (TP Hit) ---');
    updateTrailingStopLoss(trade, 150);
    
    // Check Activation
    if (!trade.sellConditions.trailingStopActivated) {
        console.error('❌ Failed: Did not activate at TP!');
    } else {
        console.log('✅ Activated!');
        console.log(`Step Level: ${trade.sellConditions.stepLevel} (Expected: 1)`);
        console.log(`Stop Price: ${trade.sellConditions.currStopPrice} (Expected: 135 [150 * 0.9])`);
    }

    // 4. Pump to $200 (+100%)
    console.log('\n--- Pump to $200 ---');
    updateTrailingStopLoss(trade, 200);
    console.log(`Step Level: ${trade.sellConditions.stepLevel} (Expected: 1)`);

    // 5. Pump to $230 (+130%) -> STEP UP
    console.log('\n--- Pump to $230 (Next Target Hit) ---');
    updateTrailingStopLoss(trade, 230);
    
    if (trade.sellConditions.stepLevel !== 2) {
        console.error(`❌ Failed: Did not step up! Level: ${trade.sellConditions.stepLevel}`);
    } else {
        console.log('✅ Stepped Up!');
        console.log(`Step Level: ${trade.sellConditions.stepLevel} (Expected: 2)`);
        console.log(`Stop Price: ${trade.sellConditions.currStopPrice} (Expected: 207 [230 * 0.9])`);
    }

    // 6. Dump to $200
    // Check Sell Logic manually since we're using partial mocks
    console.log('\n--- Dump to $200 (Below Stop) ---');
    
    if (trade.sellConditions.currStopPrice && 200 <= trade.sellConditions.currStopPrice) {
         console.log(`✅ SELL TRIGGERED! Price $200 <= Stop $${trade.sellConditions.currStopPrice}`);
    } else {
         console.error(`❌ Failed: Did not trigger sell!`);
    }
}

testSteppedTrailing();
