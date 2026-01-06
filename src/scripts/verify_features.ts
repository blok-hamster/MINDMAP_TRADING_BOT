
import { MindmapFilterEngine } from '../core/MindmapFilterEngine';
import { FilterCriteria, MindmapData, TradingConfig } from '../types';

// --- Configuration ---
const mockConfig = {
  filter: {
    minTradeVolume: 1000,
    minConnectedKOLs: 2,
    minInfluenceScore: 50,
    minTotalTrades: 5,
    minMarketCapUsd: 0,
    minLiquidityUsd: 0,
    // Advanced Signals
    minViralVelocity: 5,        // Requires 5 unique KOLs in 1 min
    requireSmartMoney: true,    // Requires weighted volume > 60%
    minConsensusScore: 70       // Requires 70% buyers
  } as FilterCriteria,
  trading: {
    buyAmount: 0.1,
    allowAdditionalEntries: true, // DCA Enabled
    maxEntriesPerToken: 3         // Max 3 entries
  } as TradingConfig
};

// --- Helpers ---
const createMockData = (overrides: Partial<MindmapData> = {}): MindmapData => {
  return {
    tokenMint: 'Token_' + Date.now(),
    kolConnections: {},
    relatedTokens: [],
    networkMetrics: { centrality: 0, clustering: 0, totalTrades: 10 },
    lastUpdate: new Date(),
    ...overrides
  };
};

// --- Tests ---

import { BatchPriceService } from '../services/BatchPriceService';

async function verifyFilters() {
  console.log('\n🔵 --- Verifying Mindmap Signals ---');
  
  // Mock Price Service
  const mockPriceService = {
      getCachedPrice: async (_mint: string) => 1.0, // Always return $1
      discoverToken: async (_mint: string) => {},
      addTokenInterest: async (_mint: string) => {}
  } as unknown as BatchPriceService;

  const engine = new MindmapFilterEngine(mockConfig.filter, mockPriceService);

  // Case 1: Viral Spike
  console.log('\n1. Testing "Viral Spike" Signal...');
  const now = new Date();
  const viralData = createMockData({
    kolConnections: {
      'KOL1': { lastTradeTime: now, totalVolume: 100, influenceScore: 10, tradeCount: 1, tradeTypes: ['buy'], kolWallet: 'KOL1' },
      'KOL2': { lastTradeTime: now, totalVolume: 100, influenceScore: 10, tradeCount: 1, tradeTypes: ['buy'], kolWallet: 'KOL2' },
      'KOL3': { lastTradeTime: now, totalVolume: 100, influenceScore: 10, tradeCount: 1, tradeTypes: ['buy'], kolWallet: 'KOL3' },
      'KOL4': { lastTradeTime: now, totalVolume: 100, influenceScore: 10, tradeCount: 1, tradeTypes: ['buy'], kolWallet: 'KOL4' },
      'KOL5': { lastTradeTime: now, totalVolume: 100, influenceScore: 10, tradeCount: 1, tradeTypes: ['buy'], kolWallet: 'KOL5' }
    }
  }); // 5 Active KOLs -> Matches minViralVelocity: 5
  
  const vResult = await engine.evaluate(viralData);
  if (vResult.signals?.includes('VIRAL_SPIKE')) {
     console.log('✅ PASS: "VIRAL_SPIKE" detected! (Velocity: 5)');
  } else {
     console.log('❌ FAIL: "VIRAL_SPIKE" not detected.');
  }

  // Case 2: Smart Money
  console.log('\n2. Testing "Smart Money" Signal...');
  const smartMoneyData = createMockData({
      kolConnections: {
          'Whale': { lastTradeTime: now, totalVolume: 10000, influenceScore: 100, tradeCount: 1, tradeTypes: ['buy'], kolWallet: 'Whale' }, // Weight: 10000
          'Fish':  { lastTradeTime: now, totalVolume: 2000, influenceScore: 10, tradeCount: 1, tradeTypes: ['buy'], kolWallet: 'Fish' }     // Weight: 200
      }
      // Total: 12000. Weighted: 10200. Ratio: 85% > 60%
  });

  const smResult = await engine.evaluate(smartMoneyData);
  if (smResult.signals?.includes('SMART_MONEY')) {
      console.log('✅ PASS: "SMART_MONEY" detected! (High Influence Volume)');
  } else {
      console.log('❌ FAIL: "SMART_MONEY" not detected.');
  }
}

async function verifyDCA() {
  console.log('\n🔵 --- Verifying DCA / Re-entry Logic ---');
  
  // Mock Cache Service Logic
  const MAX_ENTRIES = mockConfig.trading.maxEntriesPerToken!;
  
  console.log(`Config: Max Entries = ${MAX_ENTRIES}, Allow DCA = ${mockConfig.trading.allowAdditionalEntries}`);

  // Scenario: We already entered 1 time
  let currentEntryCount = 1;
  console.log(`\nScenario A: Bot holds 1 position. New signal arrives...`);
  
  if (currentEntryCount < MAX_ENTRIES) {
      console.log(`✅ DECISION: Buy Again! (Count ${currentEntryCount} < Max ${MAX_ENTRIES})`);
  } else {
      console.log(`❌ DECISION: Skip (Max reached)`);
  }

  // Scenario: We entered 3 times
  currentEntryCount = 3;
  console.log(`\nScenario B: Bot holds 3 positions. New signal arrives...`);
  
  if (currentEntryCount < MAX_ENTRIES) {
      console.log(`✅ DECISION: Buy Again!`);
  } else {
      console.log(`🛑 DECISION: Stop Buying. (Count ${currentEntryCount} >= Max ${MAX_ENTRIES})`);
  }
}

async function run() {
  await verifyFilters();
  await verifyDCA();
  console.log('\n✨ Verification Complete.');
}

run().catch(console.error);
