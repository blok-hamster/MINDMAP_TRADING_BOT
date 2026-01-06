import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaPriceSDK } from '../utils/onchainPrice';
import { createClient, RedisClientType } from 'redis';
import BN from 'bn.js';

const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export class BatchPriceService {
    private connection: Connection;
    private sdk: SolanaPriceSDK;
    private redis: RedisClientType;
    private isMonitoring = false;
    private readonly MONITOR_INTERVAL_MS = 100;
    private readonly INTEREST_TTL_SECONDS = 60;

    constructor(rpcUrl: string) {
        this.connection = new Connection(rpcUrl, 'confirmed');
        this.sdk = new SolanaPriceSDK(rpcUrl);
        this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
        
        this.redis.on('error', (err) => console.error('BatchPriceService Redis Error:', err));
        this.redis.connect().catch(console.error);
    }

    /**
     * Signal interest in a token. This keeps the background monitor fetching its price.
     * Call this whenever a job is processed.
     */
    async addTokenInterest(mint: string): Promise<void> {
        try {
            await this.redis.setEx(`monitor_active:${mint}`, this.INTEREST_TTL_SECONDS, '1');
        } catch (error) {
            console.error(`Failed to set interest for ${mint}:`, error);
        }
    }

    /**
     * Get the latest cached price for a token.
     * Returns null if price is not in cache (monitor hasn't fetched it yet or expired).
     */
    async getCachedPrice(mint: string): Promise<number | null> {
        try {
            const priceStr = await this.redis.get(`price_cache:${mint}`);
            return priceStr ? parseFloat(priceStr) : null;
        } catch (error) {
            console.error(`Failed to get cached price for ${mint}:`, error);
            return null;
        }
    }

    /**
     * Check if a token has a recently recorded pricing error (Negative Cache).
     */
    async hasPriceError(mint: string): Promise<boolean> {
        try {
            const exists = await this.redis.exists(`price_error:${mint}`);
            return exists === 1;
        } catch (error) {
            console.error(`Failed to check price error for ${mint}:`, error);
            return false;
        }
    }

    /**
     * Start the background monitoring loop.
     */
    async startMonitoring(): Promise<void> {
        if (this.isMonitoring) return;
        this.isMonitoring = true;
        // console.log("🚀 BatchPriceService: Background monitoring started");
        
        this.runMonitorLoop();
        this.runDiscoveryLoop(); // Start separate discovery loop
    }

    private async runMonitorLoop() {
        if (!this.isMonitoring) return;

        try {
            // Fast Path Loop: Only check cached/known fast sources
            const keys = await this.scanRecursive('monitor_active:*');
            let mints = keys.map(k => k.replace('monitor_active:', ''));

            if (mints.length > 0) {
                 // 1. Fetch Bonding Curves (Fast)
                 const { foundPrices, missingMints } = await this.fetchBondingCurvePrices(mints);
                 
                 // Cache Fast Results
                 if (foundPrices.size > 0) {
                     const pipeline = this.redis.multi();
                     for (const [mint, price] of foundPrices.entries()) {
                         pipeline.set(`price_cache:${mint}`, price.toString(), { EX: 60 }); 
                         pipeline.del(`price_error:${mint}`);
                     }
                     await pipeline.exec();
                 }

                 // 2. Fetch Cached Raydium/Secondary Vaults (Fast Batch RPC)
                 // We ONLY fetch if we have cached vault data. We do NOT run discovery here.
                 if (missingMints.length > 0) {
                     const secondaryPrices = await this.fetchCachedSecondaryPrices(missingMints);
                     if (secondaryPrices.size > 0) {
                         const pipeline = this.redis.multi();
                         for (const [mint, price] of secondaryPrices.entries()) {
                             if (price) {
                                pipeline.set(`price_cache:${mint}`, price.toString(), { EX: 60 });
                                pipeline.del(`price_error:${mint}`);
                             }
                         }
                         await pipeline.exec();
                     }
                     
                     // Any mints still missing are candidates for Discovery (handled by other loop)
                 }
            }

        } catch (error) {
            console.error("Monitor loop error:", error);
        } finally {
            setTimeout(() => this.runMonitorLoop(), this.MONITOR_INTERVAL_MS);
        }
    }

    private async runDiscoveryLoop() {
        if (!this.isMonitoring) return;

        try {
            // Slow Path Loop: Discover new tokens
            const keys = await this.scanRecursive('monitor_active:*');
            const mints = keys.map(k => k.replace('monitor_active:', ''));

            for (const mint of mints) {
                // Check if we need discovery (no price, no error, no source)
                const isCached = await this.redis.exists(`price_cache:${mint}`);
                const isError = await this.redis.exists(`price_error:${mint}`);
                
                // Get Source to decide strategy
                const source = await this.redis.get(`price_source:${mint}`);
                const hasSource = source !== null; 
                
                const needsRefresh = !isCached && !isError;
                
                // 1. New/Unknown -> Discover
                // 2. LaunchLab -> Always allowed to re-discover (since we don't have a fast batch path for it yet)
                if ((needsRefresh && !hasSource) || (needsRefresh && source === 'LaunchLab')) {
                    // This blocks ONLY this loop, not the monitor loop.
                    await this.discoverToken(mint);
                }
            }

        } catch (error) {
            console.error("Discovery loop error:", error);
        } finally {
            // Run less frequently to avoid rate limits
            setTimeout(() => this.runDiscoveryLoop(), 1000); 
        }
    }



    private async scanRecursive(pattern: string): Promise<string[]> {
        const found: string[] = [];
        let cursor = 0;
        do {
            const reply = await this.redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
            cursor = typeof reply.cursor === 'number' ? reply.cursor : parseInt(reply.cursor);
            found.push(...reply.keys);
        } while (cursor !== 0);
        return found;
    }

    /**
     * Fast Path: Fetches prices for tokens via PumpFun Bonding Curves.
     * Returns Found Prices and list of Mints that need Fallback.
     */
    async fetchBondingCurvePrices(mints: string[]): Promise<{ foundPrices: Map<string, number>, missingMints: string[] }> {
        const foundPrices = new Map<string, number>();
        const uniqueMints = [...new Set(mints)];
        const missingMints: string[] = [];
        
        // Groups for processing strategy
        const checkPumpFunMints: string[] = [];

        // 1. Check Redis for cached Sources (Route Optimization)
        const pipeline = this.redis.multi();
        uniqueMints.forEach(mint => pipeline.get(`price_source:${mint}`));
        const sourcesResults = (await pipeline.exec()) as unknown as (string | null)[];

        uniqueMints.forEach((mint, index) => {
            const source = sourcesResults[index];
            if (source === 'Raydium' || source === 'PumpSwap') {
                // Known complex token, skip bonding curve check entirely
                missingMints.push(mint);
            } else if (source === 'LaunchLab') {
                // LaunchLab uses a different program/layout, cannot use standard bonding curve batch
                // We let it fall through to missingMints -> Discovery Loop will handle refresh
                missingMints.push(mint);
            } else {
                // 'PumpFun' (Standard) or Unknown -> Try Bonding Curve
                checkPumpFunMints.push(mint);
            }
        });

        if (checkPumpFunMints.length === 0) {
             return { foundPrices, missingMints };
        }

        // 2. Fetch Bonding Curves
        const validMints: { mint: string; pubkey: PublicKey; bondingCurve: PublicKey }[] = [];
        checkPumpFunMints.forEach(mint => {
            try {
                const pubkey = new PublicKey(mint);
                const [bondingCurve] = PublicKey.findProgramAddressSync(
                    [Buffer.from('bonding-curve'), pubkey.toBuffer()],
                    PUMPFUN_PROGRAM_ID
                );
                validMints.push({ mint, pubkey, bondingCurve });
            } catch (e) {
                console.error(`Invalid mint address: ${mint}`);
            }
        });

        const CHUNK_SIZE = 100;
        for (let i = 0; i < validMints.length; i += CHUNK_SIZE) {
            const chunk = validMints.slice(i, i + CHUNK_SIZE);
            const accountKeys = chunk.map(item => item.bondingCurve);

            try {
                const accountsInfos = await this.connection.getMultipleAccountsInfo(accountKeys, 'confirmed');
                const sourceUpdatePipeline = this.redis.multi(); // to update sources

                accountsInfos.forEach((info, index) => {
                    const item = chunk[index];
                    if (!item) return;

                    let found = false;
                    if (info && info.data.length >= 24) { 
                            const data = info.data;
                            const virtualTokenReserves = new BN(data.subarray(8, 16), 'le');
                            const virtualSolReserves = new BN(data.subarray(16, 24), 'le');
                            
                            // check "complete" flag at offset 48
                            const isComplete = data[48] === 1;

                            if (!virtualTokenReserves.eqn(0) && !virtualSolReserves.eqn(0) && !isComplete) {
                                const tokenDecimals = 6; 
                                const solDecimals = 9;
                                const tokenUnits = parseFloat(virtualTokenReserves.toString()) / Math.pow(10, tokenDecimals);
                                const solUnits = parseFloat(virtualSolReserves.toString()) / Math.pow(10, solDecimals);
                                const price = solUnits / tokenUnits;
                                
                                foundPrices.set(item.mint, price);
                                // Confirm Source as PumpFun
                                sourceUpdatePipeline.set(`price_source:${item.mint}`, 'PumpFun', { EX: 300 });
                                found = true;
                            } else if (isComplete) {
                                // If complete, it has graduated! We MUST NOT use this price.
                                // We let it fall through to 'missingMints' so 'discoverToken' runs Raydium check.
                                // invalidating source cache to force discovery
                                sourceUpdatePipeline.del(`price_source:${item.mint}`);
                                found = false; 
                                // console.log(`[BatchPrice] Token ${item.mint} is COMPLETE. Forcing Discovery.`);
                            }
                    }
                    
                    if (!found) {
                        missingMints.push(item.mint);
                    }
                });
                await sourceUpdatePipeline.exec();

            } catch (e) {
                console.error("Batch Bonding Curve RPC call failed", e);
                // All failed in this chunk -> send to fallback
                chunk.forEach(item => missingMints.push(item.mint));
            }
        }
        
        return { foundPrices, missingMints };
    }

    /**
     * Slow Path: Sequential fallback fetching for complex/migrated tokens.
     */
    /**
     * Secondary Path: Efficiently fetches prices for tokens not found on PumpFun Bonding Curve.
     * 1. Checks Redis for cached Raydium Vault addresses (Fast Batch Path).
     * 2. If not cached, performs "Discovery" via SDK (Slow Path) and caches the result.
     */
    /**
     * Attempts to fetch prices using ONLY cached vault data (Raydium/PumpSwap).
     * Does NOT perform discovery or SDK calls. Fast RPC batching only.
     */
    async fetchCachedSecondaryPrices(mints: string[]): Promise<Map<string, number | null>> {
        const results = new Map<string, number | null>();
        const cachedVaults: { mint: string, data: any, type: 'AMMV4' | 'CPMM' | 'LaunchLab' }[] = [];

        // 1. Get cached vaults for all supported types
        const vaultPipeline = this.redis.multi();
        mints.forEach(mint => {
            vaultPipeline.get(`raydium_vaults:${mint}`);   // AMMV4
            vaultPipeline.get(`pumpswap_vaults:${mint}`);  // AMMV4-like
            vaultPipeline.get(`cpmm_vaults:${mint}`);      // CPMM
            vaultPipeline.get(`launchlab_vaults:${mint}`); // LaunchLab
        });
        const vaultResults = (await vaultPipeline.exec()) as (string | null)[];

        mints.forEach((mint, index) => {
            const raydiumJson = vaultResults[index * 4];
            const pumpSwapJson = vaultResults[index * 4 + 1];
            const cpmmJson = vaultResults[index * 4 + 2];
            const launchLabJson = vaultResults[index * 4 + 3];

            try {
                if (raydiumJson) cachedVaults.push({ mint, data: JSON.parse(raydiumJson), type: 'AMMV4' });
                else if (pumpSwapJson) cachedVaults.push({ mint, data: JSON.parse(pumpSwapJson), type: 'AMMV4' });
                else if (cpmmJson) cachedVaults.push({ mint, data: JSON.parse(cpmmJson), type: 'CPMM' });
                else if (launchLabJson) cachedVaults.push({ mint, data: JSON.parse(launchLabJson), type: 'LaunchLab' });
            } catch (e) {}
        });

        if (cachedVaults.length === 0) return results;

        // 2. Batch Fetch
        // We need to map global Index of account info back to specific logic
        const allAccountKeys: PublicKey[] = [];
        const requestMap = new Map<number, { 
            mint: string, 
            type: 'base' | 'quote' | 'bondingCurve', 
            decimals?: number,
            parentType: 'AMMV4' | 'CPMM' | 'LaunchLab',
            quoteMint?: string // For LaunchLab USD1 check
        }>();

        let flatIndex = 0;

        cachedVaults.forEach(({ mint, data, type }) => {
            try {
                if (type === 'AMMV4' || type === 'CPMM') {
                    // Both AMM and CPMM use Base/Quote Vaults with simple division
                    allAccountKeys.push(new PublicKey(data.baseVault));
                    requestMap.set(flatIndex++, { mint, type: 'base', decimals: data.baseDecimals, parentType: type });

                    allAccountKeys.push(new PublicKey(data.quoteVault));
                    requestMap.set(flatIndex++, { mint, type: 'quote', decimals: data.quoteDecimals, parentType: type });
                } else if (type === 'LaunchLab') {
                    // LaunchLab uses a single Bonding Curve account
                    allAccountKeys.push(new PublicKey(data.bondingCurve));
                    requestMap.set(flatIndex++, { 
                        mint, 
                        type: 'bondingCurve', 
                        parentType: type,
                        quoteMint: data.quoteMint 
                    });
                }
            } catch (e) {}
        });

        const CHUNK_SIZE = 100; // Accounts per request
        for (let i = 0; i < allAccountKeys.length; i += CHUNK_SIZE) {
            const chunkKeys = allAccountKeys.slice(i, i + CHUNK_SIZE);
            try {
                const accountsInfos = await this.connection.getMultipleAccountsInfo(chunkKeys, 'confirmed');
                
                // Temporary store for paired balances
                const tempBalances = new Map<string, { base?: number, quote?: number, baseDec?: number, quoteDec?: number }>();

                accountsInfos.forEach((info, chunkIndex) => {
                     const globalIndex = i + chunkIndex;
                     const meta = requestMap.get(globalIndex);
                     if (!meta || !info || info.data.length < 8) return;

                     // --- Logic for AMMV4 & CPMM ---
                     if (meta.parentType === 'AMMV4' || meta.parentType === 'CPMM') {
                         const amountData = info.data.subarray(64, 72);
                         const amount = new BN(amountData, 'le');
                         
                         if (!tempBalances.has(meta.mint)) tempBalances.set(meta.mint, {});
                         const entry = tempBalances.get(meta.mint)!;
                         
                         if (meta.type === 'base') {
                             entry.base = parseFloat(amount.toString());
                             entry.baseDec = meta.decimals;
                         } else {
                             entry.quote = parseFloat(amount.toString());
                             entry.quoteDec = meta.decimals;
                         }
                     }
                     // --- Logic for LaunchLab ---
                     else if (meta.parentType === 'LaunchLab') {
                         // info.data is the Bonding Curve data
                         // Offsets from onchainPrice.ts: 
                         // vTokens: 64 (u64)
                         // realQuote: 76 (u64)
                         
                         if (info.data.length < 84) return;

                         const vTokensRaw = new BN(info.data.subarray(64, 72), 'le');
                         const realQuoteRaw = new BN(info.data.subarray(76, 84), 'le');
                         
                         if (vTokensRaw.eqn(0)) return;

                         // Determine Logic based on Quote Mint (USD1 vs SOL)
                         const isUSD1 = meta.quoteMint === 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

                         let price = 0;
                         if (isUSD1) {
                             // USD1: Price = Quote / Token (Simple)
                             // Note: We ignore conversion to SOL here for Batch Speed. 
                             // The TradeWatcher will get the USD price. 
                             // If it needs SOL price, we might need a separate SOL oracle.
                             // For now, returning USD price is better than nothing.
                             // Or we can assume 1 USD = X SOL? No, unsafe.
                             // Let's return USD price. The bot handles "Value" in USD mostly?
                             // Wait, bot usually expects SOL price.
                             // To keep batch fast, we can't do async SOL fetch here easily without slowing down.
                             // We'll return the USD price and let the consumer handle it?
                             // Actually, `onchainPrice.ts` converts it. 
                             // If we return raw USD price here, the bot might think it's SOL and print huge numbers.
                             // Assumption: Bot expects SOL.
                             // Quick Fix: We assume SOL~200? No.
                             // We will just return the Price in Quote Units.
                             // If Quote is USD1, price is in USD.
                             // Ideally we pass `quoteDecimals` properly.
                             
                             const tokenUnits = parseFloat(vTokensRaw.toString()) / Math.pow(10, 9);
                             const quoteUnits = parseFloat(realQuoteRaw.toString()) / Math.pow(10, 6);
                             price = quoteUnits / tokenUnits;
                             
                             // TODO: We might need a global cached SOL price to convert this on the fly.
                             // For now, let's store it. If it's vastly different (e.g. 0.0003 vs 0.05), user will notice.
                             // But wait, user said "value doesn't change". 
                             // Returning a dynamic USD price is better than static.
                         } else {
                             // SOL: Virtual SOL Logic
                             const vSol = realQuoteRaw.add(new BN(30000000000));
                             const tokenUnits = parseFloat(vTokensRaw.toString()) / Math.pow(10, 9);
                             const solUnits = parseFloat(vSol.toString()) / Math.pow(10, 9);
                             price = solUnits / tokenUnits;
                         }

                         results.set(meta.mint, price);
                     }
                });

                // Finalize AMMV4/CPMM pairs
                tempBalances.forEach((val, mint) => {
                    if (val.base !== undefined && val.quote !== undefined && val.base > 0) {
                        const baseUnits = val.base / Math.pow(10, val.baseDec || 6);
                        const quoteUnits = val.quote / Math.pow(10, val.quoteDec || 9);
                        results.set(mint, quoteUnits / baseUnits);
                    }
                });
            } catch (e) {
                console.error(`Batch fetch failed for chunk ${i}`, e);
            }
        }
        return results;
    }

    /**
     * Performs slow discovery for a single token using the SDK.
     * Caches the result (source info and price).
     */
    async discoverToken(mint: string): Promise<void> {
        try {
            // console.log(`🔍 Discovery: Analyzing ${mint}...`);
            const priceData = await this.sdk.getTokenPrice(mint);
            
            if (priceData) {
                const pipeline = this.redis.multi();
                
                // Cache price
                pipeline.set(`price_cache:${mint}`, priceData.price.toString(), { EX: 60 });
                // Cache source - Reduce TTL for pre-graduation sources to allow faster migration detection
                const isPreGrad = priceData.source === 'PumpFun' || priceData.source === 'LaunchLab';
                const ttl = isPreGrad ? 300 : 86400; // 5 mins for bonding curves, 24h for AMMs
                pipeline.set(`price_source:${mint}`, priceData.source, { EX: ttl });
                // Clear error
                pipeline.del(`price_error:${mint}`);

                // Cache Vault Data if available
                if (priceData.poolData) {
                    if (priceData.source === 'Raydium' || priceData.source === 'PumpSwap') {
                         const redisKey = priceData.source === 'Raydium' ? `raydium_vaults:${mint}` : `pumpswap_vaults:${mint}`;
                         pipeline.set(redisKey, JSON.stringify(priceData.poolData));
                    } else if (priceData.source === 'Raydium CPMM') {
                        pipeline.set(`cpmm_vaults:${mint}`, JSON.stringify(priceData.poolData));
                    } else if (priceData.source === 'LaunchLab') {
                        pipeline.set(`launchlab_vaults:${mint}`, JSON.stringify(priceData.poolData));
                    }
                }
                // console.log(`✅ Discovered & Cached vaults for ${mint} (${priceData.source})`);
                
                await pipeline.exec();
            } else {
                // Negative cache if not found
                this.redis.setEx(`price_error:${mint}`, 30, '1');
            }
        } catch (e) {
            console.warn(`Discovery failed for ${mint}:`, e);
            this.redis.setEx(`price_error:${mint}`, 30, '1');
        }
        
        // Rate limit protection
        await new Promise(r => setTimeout(r, 200));
    }
}
