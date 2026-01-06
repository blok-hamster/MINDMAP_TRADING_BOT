import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { pumpPortalService } from '../services/PumpPortalPriceService';

/**
 * PRODUCTION GRADE SOLANA TOKEN PRICE SDK (V26 - PumpFun Fix)
 *
 * * FIX: Updated Pump Fun Program ID to '6EF8...' (The correct mainnet program).
 * * FIX: Updated PDA Seed to 'bonding-curve'.
 * * FIX: Updated Bonding Curve Offsets for '6EF8...' layout (Virtual Reserves @ 8 and 16).
 * * Strategies: Raydium (On-Chain AMM) and Pump Fun (Unified: PumpSwap AMM or Bonding Curve).
 */

// --- Constants (Accessed via Private Methods) ---

const RAYDIUM_V4_PROGRAM_ID_STR = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
// THE CORRECT PUMP.FUN PROGRAM ID
const PUMPFUN_PROGRAM_ID_STR = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'; 
// PumpSwap AMM Program ID
// PumpSwap AMM Program ID
const PUMPSWAP_AMM_PROGRAM_ID_STR = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'; 
// Raydium LaunchLab Program ID (LetsBonk)
const LAUNCHLAB_PROGRAM_ID_STR = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj'; 

const SOL_MINT_STR = 'So11111111111111111111111111111111111111112'; 
const USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface TokenPrice {
    price: number;
    liquidity: number; // Represents approximate USD or SOL liquidity
    source: 'Raydium' | 'Raydium CPMM' | 'PumpFun' | 'PumpSwap' | 'LaunchLab';
    pair: string;
    quoteMint: string;
    decimals: number; // The decimals of the requested token
    originalPrice?: number; // The price in the original quote currency (if converted)
    originalQuoteMint?: string; // The original quote mint (if converted)
    poolData?: {
        baseVault?: string;
        quoteVault?: string;
        baseDecimals?: number;
        quoteDecimals?: number;
        bondingCurve?: string;
        quoteMint?: string;
    };
}

interface PaginatedAccount {
    pubkey: string;
    account: {
        data: [string, 'base64'];
        executable: boolean;
        lamports: number;
        owner: string;
        rentEpoch: number;
    }
}

export class SolanaPriceSDK {
    private connection: Connection;
    private rpcEndpoint: string; 
    private pageLimit = 10; 

    constructor(endpoint: string) {
        console.log(`SDK Initialized. RPC Endpoint: ${endpoint}`);
        this.connection = new Connection(endpoint, 'confirmed');
        this.rpcEndpoint = endpoint; 
    }

    // --- Private Methods for Stable Public Key Initialization ---
    
    private _newPublicKeyAtomic(keyString: string): PublicKey {
        try {
            return new PublicKey(keyString); 
        } catch (e:any) {
             throw new Error(`[Atomic Public Key Error] Failed to create key for ${keyString}. ${e.message}`);
        }
    }

    private _getRaydiumProgramId(): PublicKey { return this._newPublicKeyAtomic(RAYDIUM_V4_PROGRAM_ID_STR); }
    private _getPumpFunProgramId(): PublicKey { return this._newPublicKeyAtomic(PUMPFUN_PROGRAM_ID_STR); }
    private _getLaunchLabProgramId(): PublicKey { return this._newPublicKeyAtomic(LAUNCHLAB_PROGRAM_ID_STR); }
    private _getPumpSwapAmmId(): PublicKey { return this._newPublicKeyAtomic(PUMPSWAP_AMM_PROGRAM_ID_STR); }
    private _getSolMint(): PublicKey { return this._newPublicKeyAtomic(SOL_MINT_STR); }
    private _getUsdcMint(): PublicKey { return this._newPublicKeyAtomic(USDC_MINT_STR); }

    private _newPublicKey(keyString: string): PublicKey {
        return new PublicKey(keyString.replace(/[^\x20-\x7E]/g, '').trim());
    }

    /**
     * Main entry point to get the price of a token using only on-chain data.
     */
    async getTokenPrice(tokenMintAddress: string): Promise<TokenPrice | null> {
        try {
            const mint = this._newPublicKey(tokenMintAddress);
            const decimals = await this.getMintDecimals(mint);
            if (decimals === null) {
                console.error('Could not fetch mint decimals. Invalid Token Address?');
                return null;
            }

            // Ensure subscription is active for WebSocket pricing
            pumpPortalService.subscribeToToken(tokenMintAddress);

            // Run all on-chain strategies in parallel
            const strategyPromises = [
                // 1. Raydium AMM Liquidity (High Priority)
                this.getRaydiumPrice(mint, decimals).catch(e => { console.warn(`Raydium Strategy failed: ${e.message || e}`); return null; }),
                
                // 1b. Raydium CPMM (Standard V2)
                this.getRaydiumCPMMPrice(mint, decimals).catch(e => { console.warn(`Raydium CPMM Strategy failed: ${e.message || e}`); return null; }),

                // 2. Pump Fun Unified Check (PumpSwap AMM -> Bonding Curve)
                this.getPumpFunUnifiedPrice(mint, decimals).catch(e => { console.warn(`Pump Fun Unified Strategy failed: ${e.message || e}`); return null; }),

                // 3. Raydium LaunchLab (LetsBonk) - Reverse Engineered RPC Scan
                this.getLaunchLabPrice(mint, decimals).catch(e => { console.warn(`LaunchLab Strategy failed: ${e.message || e}`); return null; }),

                // 4. PumpPortal WebSocket (Fallback / Real-time)
                this.getPumpPortalPrice(mint, decimals).catch(e => { console.warn(`PumpPortal Strategy failed: ${e.message || e}`); return null; }),
            ];

            const results = (await Promise.all(strategyPromises)).filter(p => p !== null) as TokenPrice[];

            if (results.length === 0) {
                console.warn('No active on-chain pool found for this token.');
                return null;
            }

            // Select the best result based on price stability/liquidity heuristic
            return results.reduce((best, current) => 
                (current.liquidity > best.liquidity) ? current : best
            );

        } catch (error) {
            console.error('CRITICAL: Error during initial setup or token parsing:', error);
            return null;
        }
    }
    
    // --- Custom Fetcher for Raw JSON-RPC Calls ---

    private async _fetchRawRpc(method: string, params: any[]): Promise<any> {
        const payload = {
            jsonrpc: '2.0',
            id: 'custom-rpc',
            method: method,
            params: params,
        };

        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(this.rpcEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
        
                if (!response.ok) {
                    throw new Error(`RPC call failed with status: ${response.status}`);
                }
                
                const data:any = await response.json();
                
                if (data.error) {
                    throw new Error(`RPC error from server: ${data.error.message}`);
                }
                return data;
            } catch (error) {
                if (attempt === maxRetries - 1) {
                    throw error;
                }
                const delay = Math.pow(2, attempt) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    private async _fetchPaginatedProgramAccountsV2(
        programId: PublicKey, 
        filters: any[], 
        _limit: number, 
        _maxPages: number
    ): Promise<PaginatedAccount[]> {
        // Fallback to standard getProgramAccounts since filters are specific enough (pair matching)
        // Pagination is not standard in generic Solana RPCs, so 'getProgramAccountsV2' fails on Helius/QuickNode/etc.
        
        const params: any[] = [
            programId.toBase58(),
            {
                filters: filters,
                encoding: 'base64',
                withContext: false
                // Standard RPC does not support 'limit' at top level for all providers, 
                // but we rely on strict filters to keep result set small.
            },
        ];

        try {
            const response = await this._fetchRawRpc('getProgramAccounts', params);
            
            // Standard JSON-RPC response format: { result: [...] }
            if (response.result && Array.isArray(response.result)) {
                return response.result as PaginatedAccount[];
            }
            
            return [];

        } catch (error:any) {
            console.warn(`Error fetching program accounts: ${error.message}`);
            return [];
        }
    }

    // --- Strategy 1: Raydium (AMM Liquidity Check) ---

    private async getRaydiumPrice(tokenMint: PublicKey, tokenDecimals: number, preventConversion: boolean = false): Promise<TokenPrice | null> {
        const raydiumProgramId = this._getRaydiumProgramId();
        const solMint = this._getSolMint();
        const usdcMint = this._getUsdcMint();
        const usd1Mint = new PublicKey('USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB');

        // Supported Quotes Map (for fast lookup)
        const supportedQuotes = new Map<string, { decimals: number, name: string, isUSD1?: boolean }>([
            [solMint.toBase58(), { decimals: 9, name: 'SOL' }],
            [usdcMint.toBase58(), { decimals: 6, name: 'USDC' }],
            [usd1Mint.toBase58(), { decimals: 6, name: 'USD1', isUSD1: true }]
        ]);

        let bestPool: TokenPrice | null = null;

        // Search Filters: Find pools where Token is Base OR Quote
        // Note: We can't do OR in one call easily with standard filters without multiple calls or larger fetches.
        // To be safe and avoid 429 loops, we'll try the most common configuration first (Base = Token).
        // If that fails, we check (Quote = Token).

        const checkPools = async (isBase: boolean) => {
             const filters = [
                { dataSize: 752 },
                { memcmp: { offset: isBase ? 400 : 432, bytes: tokenMint.toBase58() } }
            ];

            const accounts = await this._fetchPaginatedProgramAccountsV2(
                raydiumProgramId, filters, this.pageLimit, 2 // Limit pages to finding the pool quickly
            );

            if (accounts.length === 0) return;

            const vaultPubkeys: PublicKey[] = [];
            
            // Pre-process accounts to extract vaults
            accounts.forEach(account => {
                const data = Buffer.from(account.account.data[0], 'base64');
                vaultPubkeys.push(new PublicKey(data.subarray(336, 368))); // Base Vault
                vaultPubkeys.push(new PublicKey(data.subarray(368, 400))); // Quote Vault
            });

            // Fetch Vault Balances
            const balances = await this.connection.getMultipleAccountsInfo(vaultPubkeys);

            if (tokenMint.toBase58() === 'CpN1PZ6CYsU2fUe9xenqD4JWDGdGhA2PCFAQXpv8krGR') {
                 console.log(`[Target Debug] Checking ${accounts.length} potential pools for CpN1... (isBase=${isBase})`);
            }

            for (let i = 0; i < accounts.length; i++) {
                const data = Buffer.from(accounts[i].account.data[0], 'base64');
                const baseMint = new PublicKey(data.subarray(400, 432));
                const quoteMint = new PublicKey(data.subarray(432, 464));

                // Identify which is the "Paired" token
                const pairedMint = isBase ? quoteMint : baseMint;
                const pairedMintStr = pairedMint.toBase58();
                const quoteInfo = supportedQuotes.get(pairedMintStr);

                if (!quoteInfo) {
                    if (tokenMint.toBase58() === 'CpN1PZ6CYsU2fUe9xenqD4JWDGdGhA2PCFAQXpv8krGR') {
                        console.log(`[Target Debug] Skipping pool paired with unsupported mint: ${pairedMintStr}`);
                    }
                    continue; 
                }

                console.log(`[Raydium Debug] Found supported pair: ${quoteInfo.name} (${pairedMintStr})`);

                const [baseBalanceInfo, quoteBalanceInfo] = [balances[i * 2], balances[i * 2 + 1]];
                if (!baseBalanceInfo || !quoteBalanceInfo) continue;

                const baseReserve = new BN(baseBalanceInfo.data.subarray(64, 72), 'le');
                const quoteReserve = new BN(quoteBalanceInfo.data.subarray(64, 72), 'le');

                if (baseReserve.eqn(0) || quoteReserve.eqn(0)) continue;

                // Calculate Price
                // If Token is Base: Price = Quote / Base
                // If Token is Quote: Price = Base / Quote (Inverted relation if we want price of Token in Quote)
                // Wait, standard price is always Quote / Base.
                // But if we want Price of "Token", and Token is Base, then Price = QuoteAmt / TokenAmt.
                // If Token is Quote, then Price = BaseAmt / TokenAmt (This gives Price in Base terms).

                // Let's standardise: We want Price of TOKEN in terms of PAIRED ASSET (SOL/USD).
                
                let tokenAmount: number, pairedAmount: number;
                let tokenDecimalsReal = tokenDecimals;
                let pairedDecimals = quoteInfo.decimals;

                if (isBase) {
                     tokenAmount = parseFloat(baseReserve.toString()) / Math.pow(10, tokenDecimalsReal);
                     pairedAmount = parseFloat(quoteReserve.toString()) / Math.pow(10, pairedDecimals);
                } else {
                     // Token is Quote
                     tokenAmount = parseFloat(quoteReserve.toString()) / Math.pow(10, tokenDecimalsReal);
                     pairedAmount = parseFloat(baseReserve.toString()) / Math.pow(10, pairedDecimals);
                }

                let price = pairedAmount / tokenAmount;
                let liquidity = pairedAmount; // Liquidity in Terms of Quote (USD/SOL)
                let pairName = quoteInfo.name;
                let quoteMintStr = pairedMintStr;

                 // USD1 Conversion
                 if (quoteInfo.isUSD1 && !preventConversion) {
                     const usdPrice = price;
                     try {
                        const solPrice = await this.getSolUsdPrice();
                        if (solPrice) {
                            price = usdPrice / solPrice;
                            pairName = 'SOL (Converted from Raydium USD1)';
                            quoteMintStr = solMint.toBase58();
                        }
                     } catch (e) { console.warn('Failed to fetch SOL price for conversion'); }
                }

                if (!bestPool || liquidity > bestPool.liquidity) {
                    bestPool = {
                        price: price, liquidity: liquidity, source: 'Raydium',
                        pair: pairName, quoteMint: quoteMintStr, decimals: tokenDecimals,
                         poolData: {
                            baseVault: vaultPubkeys[i * 2].toBase58(),
                            quoteVault: vaultPubkeys[i * 2 + 1].toBase58(),
                            baseDecimals: tokenDecimalsReal,
                            quoteDecimals: pairedDecimals
                        }
                    };
                }
            }
        };

        // 1. Check Standard: Base = Token (Most common)
        await checkPools(true);
        if (bestPool) return bestPool;

        // 2. Check Reverse: Quote = Token (Rare but possible)
        // Add small delay to prevent rate limit
        await new Promise(resolve => setTimeout(resolve, 500));
        await checkPools(false);

        return bestPool;
    }

    // --- Strategy 1b: Raydium CPMM (New Standard) ---
    private async getRaydiumCPMMPrice(tokenMint: PublicKey, tokenDecimals: number): Promise<TokenPrice | null> {
        const cpmmProgramId = new PublicKey('CPMMoo8L3F4NbTneafuM5YxW4WnbMSaW7a2DAAG1Biwq');
        const solMint = this._getSolMint();
        const usdcMint = this._getUsdcMint();
        
        // CPMM Layout: 
        // MintA: Offset 64
        // MintB: Offset 96
        
        // Filter: Token is MintA or MintB
        const filters = [
            { dataSize: 637 }, // Standard CPMM Pool Size
            { memcmp: { offset: 64, bytes: tokenMint.toBase58() } } // Try MintA first
        ];

        // We can check MintB later if needed, but lets verify MintA first
        const accounts = await this._fetchPaginatedProgramAccountsV2(cpmmProgramId, filters, this.pageLimit, 1);
        
        for (const account of accounts) {
             const data = Buffer.from(account.account.data[0], 'base64');
             const mintA = new PublicKey(data.subarray(64, 96));
             const mintB = new PublicKey(data.subarray(96, 128));
             
             const vaultA = new PublicKey(data.subarray(168, 200));
             const vaultB = new PublicKey(data.subarray(200, 232));

             // Determine paired token
             const pairedMint = mintA.equals(tokenMint) ? mintB : mintA;
             
             let pairName = 'Unknown';
             if (pairedMint.equals(solMint)) pairName = 'SOL';
             if (pairedMint.equals(usdcMint)) pairName = 'USDC';

             if (pairName === 'Unknown') continue; // Only support SOL/USDC pairs for now

             const balances = await this.connection.getMultipleAccountsInfo([vaultA, vaultB]);
             if (!balances[0] || !balances[1]) continue;

             const reserveA = new BN(balances[0].data.subarray(64, 72), 'le');
             const reserveB = new BN(balances[1].data.subarray(64, 72), 'le');
             
             // Calculate Price
             // If Token is A, Price = B / A
             const tokenReserve = mintA.equals(tokenMint) ? reserveA : reserveB;
             const pairedReserve = mintA.equals(tokenMint) ? reserveB : reserveA;
             const pairedDecimals = pairName === 'SOL' ? 9 : 6;

             const tokenUnits = parseFloat(tokenReserve.toString()) / Math.pow(10, tokenDecimals);
             const pairedUnits = parseFloat(pairedReserve.toString()) / Math.pow(10, pairedDecimals);
             
             if(tokenUnits === 0) continue;

             const price = pairedUnits / tokenUnits;
             
             return {
                 price: price, liquidity: pairedUnits, source: 'Raydium CPMM',
                 pair: pairName, quoteMint: pairedMint.toBase58(), decimals: tokenDecimals,
                 poolData: {
                     bondingCurve: account.pubkey, // Using bondingCurve field for Pool Address
                     quoteMint: pairedMint.toBase58(),
                     baseVault: mintA.equals(tokenMint) ? vaultA.toBase58() : vaultB.toBase58(),
                     quoteVault: mintA.equals(tokenMint) ? vaultB.toBase58() : vaultA.toBase58(),
                 }
             };
        }
        
        return null;
    }

    // --- Strategy 2a: PumpSwap AMM (Post-Graduation) ---

    private async getPumpSwapPrice(tokenMint: PublicKey, tokenDecimals: number): Promise<TokenPrice | null> {
        const pumpSwapAmmId = this._getPumpSwapAmmId();
        const solMint = this._getSolMint();
        const solDecimals = 9;

        const filters = [
            { memcmp: { offset: 43, bytes: tokenMint.toBase58() } },
            { memcmp: { offset: 75, bytes: solMint.toBase58() } },
        ];
        
        const accounts = await this._fetchPaginatedProgramAccountsV2(
            pumpSwapAmmId, filters, this.pageLimit, 1
        );

        if (accounts.length === 0) return null;

        const poolAccount = accounts[0];
        if(!poolAccount) return null

        const data = Buffer.from(poolAccount.account.data[0], 'base64');

        try {
            const baseVaultPubkey = new PublicKey(data.subarray(139, 171)); 
            const quoteVaultPubkey = new PublicKey(data.subarray(171, 203)); 

            const balances = await this.connection.getMultipleAccountsInfo([baseVaultPubkey, quoteVaultPubkey]);
            const [baseBalanceInfo, quoteBalanceInfo] = [balances[0], balances[1]];

            if (!baseBalanceInfo || !quoteBalanceInfo) return null;

            const baseReserve = new BN(baseBalanceInfo.data.subarray(64, 72), 'le');
            const quoteReserve = new BN(quoteBalanceInfo.data.subarray(64, 72), 'le');

            if (baseReserve.eqn(0) || quoteReserve.eqn(0)) return null;

            const baseUnits = parseFloat(baseReserve.toString()) / Math.pow(10, tokenDecimals);
            const quoteUnits = parseFloat(quoteReserve.toString()) / Math.pow(10, solDecimals);

            const price = quoteUnits / baseUnits;
            const liquidity = parseFloat(quoteReserve.toString()); 

            return {
                price: price, liquidity: liquidity, source: 'PumpSwap',
                pair: 'SOL', quoteMint: solMint.toBase58(), decimals: tokenDecimals,
                poolData: {
                    baseVault: baseVaultPubkey.toBase58(),
                    quoteVault: quoteVaultPubkey.toBase58(),
                    baseDecimals: tokenDecimals,
                    quoteDecimals: solDecimals
                }
            };

        } catch (e: any) {
            console.error(`[PumpSwap Debug] Error parsing PumpSwap AMM account data: ${e.message}`);
            return null;
        }
    }

    // --- Strategy 2b: Pump Fun Bonding Curve (Pre-Graduation) ---

    private derivePumpFunBondingCurveAddress(tokenMint: PublicKey): PublicKey {
        const programId = this._getPumpFunProgramId();
        const [pda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from('bonding-curve'), // CORRECT SEED FOR PUMP.FUN
                tokenMint.toBuffer(),
            ],
            programId
        );
        return pda;
    }

    private async getPumpFunBondingCurvePrice(tokenMint: PublicKey, tokenDecimals: number): Promise<TokenPrice | null> {
        const bondingCurveAddress = this.derivePumpFunBondingCurveAddress(tokenMint);
        const solMint = this._getSolMint();
        const solDecimals = 9;

        // console.log(`[Bonding Curve Debug] Derived PDA: ${bondingCurveAddress.toBase58()}`);

        const accountInfo = await this.connection.getAccountInfo(bondingCurveAddress);

        if (!accountInfo || accountInfo.data.length === 0) {
            // console.warn(`[Bonding Curve Debug] Account not found. Mint: ${tokenMint.toBase58()}`);
            return null; 
        }
        
        try {
            // *** 6EF8... Program Layout Offsets ***
            // Discriminator: 8 bytes
            // Virtual Token Reserves (u64): Offset 8
            // Virtual SOL Reserves (u64): Offset 16
            // Real Token Reserves (u64): Offset 24
            // Real SOL Reserves (u64): Offset 32
            
            const data = accountInfo.data;
            
            // Read Virtual Reserves for Price Calculation
            const virtualTokenReserves = new BN(data.subarray(8, 16), 'le');
            const virtualSolReserves = new BN(data.subarray(16, 24), 'le');

             // Read Real SOL Reserves for Liquidity (TVL)
            const realSolReserves = new BN(data.subarray(32, 40), 'le');

            // console.log(`[Bonding Curve Debug] Virtual Token Reserves: ${virtualTokenReserves.toString()}`);
            // console.log(`[Bonding Curve Debug] Virtual SOL Reserves: ${virtualSolReserves.toString()}`);
            // console.log(`[Bonding Curve Debug] Real SOL Reserves (TVL): ${realSolReserves.toString()}`);
            
            if (virtualTokenReserves.eqn(0) || virtualSolReserves.eqn(0)) {
                return null;
            }

            const tokenUnits = parseFloat(virtualTokenReserves.toString()) / Math.pow(10, tokenDecimals);
            const solUnits = parseFloat(virtualSolReserves.toString()) / Math.pow(10, solDecimals);

            // Price in SOL = Virtual Sol / Virtual Token
            const price = solUnits / tokenUnits;
            // Liquidity = Real SOL Reserves (Actual TVL)
            const liquidity = parseFloat(realSolReserves.toString()); 

            return {
                price: price, liquidity: liquidity, source: 'PumpFun',
                pair: 'SOL', quoteMint: solMint.toBase58(), decimals: tokenDecimals
            };

        } catch (e:any) {
            console.error(`[Bonding Curve Debug] Error parsing bonding curve: ${e.message}`);
            return null;
        }
    }

    // --- Strategy 2: Pump Fun Unified Entrypoint (Prioritizes AMM) ---

    private async getPumpFunUnifiedPrice(tokenMint: PublicKey, tokenDecimals: number): Promise<TokenPrice | null> {
        // 1. Try PumpSwap AMM (Post-Graduation)
        const ammPrice = await this.getPumpSwapPrice(tokenMint, tokenDecimals);

        if (ammPrice) {
            // console.log(`[PumpFun Unified] Found price on PumpSwap AMM.`);
            return ammPrice;
        }

        // 2. Fallback to Bonding Curve (Pre-Graduation)
        const bcPrice = await this.getPumpFunBondingCurvePrice(tokenMint, tokenDecimals);
        
        if (bcPrice) {
            // console.log(`[PumpFun Unified] Found price on Bonding Curve.`);
            return bcPrice;
        }

        return null;
    }

    // --- Strategy 3: Raydium LaunchLab (LetsBonk RPC) ---

    private async getLaunchLabPrice(tokenMint: PublicKey, tokenDecimals: number): Promise<TokenPrice | null> {
        const launchLabId = this._getLaunchLabProgramId();
        const solMint = this._getSolMint();
        
        // Use Reverse-Engineered Filter: Mint Address is at Offset 205
        const filters = [
            { memcmp: { offset: 205, bytes: tokenMint.toBase58() } }
        ];

        // Fetch potentially matching accounts
        const accounts = await this._fetchPaginatedProgramAccountsV2(
            launchLabId, filters, 1, 1
        );

        if (accounts.length === 0) return null;

        const bondingCurve = accounts[0];
        const data = Buffer.from(bondingCurve.account.data[0], 'base64');

            // *** Reverse Engineered Layout for LaunchLab ***
            // Mint Address: Offset 205
            // Virtual Token Reserves: Offset 64 (u64, 9 decimals)
            // Real Quote Reserves: Offset 76 (u64)
            // Quote Mint Address: Offset 237

            const quoteMintOffset = 237;
            const foundQuoteMint = new PublicKey(data.subarray(quoteMintOffset, quoteMintOffset + 32));
            const isUSD1 = foundQuoteMint.toBase58() === 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

            const vTokensRaw = new BN(data.subarray(64, 72), 'le');
            const realQuoteRaw = new BN(data.subarray(76, 84), 'le');
            
            if (vTokensRaw.eqn(0)) return null;

            let price = 0;
            let liquidity = 0;
            let pair = 'SOL';
            let quoteMintStr = solMint.toBase58();

            if (isUSD1) {
                // USD1 Strategy (6 Decimals) -> Convert to SOL
                // Use Real Reserves directly as VQuote
                const tokenUnits = parseFloat(vTokensRaw.toString()) / Math.pow(10, 9);
                const quoteUnits = parseFloat(realQuoteRaw.toString()) / Math.pow(10, 6); // 6 Decimals for USD1
                
                const usdPrice = quoteUnits / tokenUnits;
                liquidity = quoteUnits; // Liquidity in USD
                
                // Fetch SOL/USD Price to convert
                const solPrice = await this.getSolUsdPrice();
                if (solPrice) {
                    price = usdPrice / solPrice;
                    pair = 'SOL (Converted from USD1)';
                    // We report quoteMint as SOL because the price is now in SOL
                    quoteMintStr = solMint.toBase58(); 
                } else {
                    // Fallback to strict USD if we can't find SOL price (rare)
                    // This might trigger strange PnL if not handled, but better than returning 0
                    console.warn(`Could not fetch SOL price for USD1 conversion on ${solMint.toBase58()}`);
                    price = usdPrice;
                    pair = 'USD';
                    quoteMintStr = foundQuoteMint.toBase58();
                }
            } else {
                 // SOL Strategy (9 Decimals)
                 // Virtual SOL = Real SOL + 30 SOL (Bootstrap)
                 const vSol = realQuoteRaw.add(new BN(30000000000)); 
                 if (vSol.eqn(0)) return null;

                 const tokenUnits = parseFloat(vTokensRaw.toString()) / Math.pow(10, 9); 
                 const solUnits = parseFloat(vSol.toString()) / Math.pow(10, 9);
     
                 price = solUnits / tokenUnits;
                 liquidity = parseFloat(realQuoteRaw.toString()) / Math.pow(10, 9); // Real SOL
            }

            const result: TokenPrice = {
                price: price, 
                liquidity: liquidity, 
                source: 'LaunchLab', 
                pair: pair, 
                quoteMint: quoteMintStr, 
                decimals: tokenDecimals,
                poolData: {
                    bondingCurve: bondingCurve.pubkey,
                    quoteMint: foundQuoteMint.toBase58()
                }
            };

            // Attach original price info if conversion happened (USD1 strategy)
            if (isUSD1) {
                const tokenUnits = parseFloat(vTokensRaw.toString()) / Math.pow(10, 9);
                const quoteUnits = parseFloat(realQuoteRaw.toString()) / Math.pow(10, 6);
                result.originalPrice = quoteUnits / tokenUnits;
                result.originalQuoteMint = foundQuoteMint.toBase58();
            }

            return result;
        } catch (e: any) {
             console.error(`Error parsing LaunchLab account: ${e.message}`);
             return null;

    }

    // --- Strategy 4: PumpPortal (WebSocket Cache) ---

    private async getPumpPortalPrice(tokenMint: PublicKey, tokenDecimals: number): Promise<TokenPrice | null> {
        const mintStr = tokenMint.toBase58();
        
        // Try to get price (either from cache or wait briefly for WS to catch up)
        const price = await pumpPortalService.waitForPrice(mintStr, 2000); // 2 second max wait for new subscriptions
        
        if (!price) return null;

        const solMint = this._getSolMint();
        
        // Return structured TokenPrice
        return {
            price: price,
            liquidity: 1000, // Implied liquidity (arbitrary non-zero to satisfy filters if needed, or track real reserves)
            source: 'PumpFun', 
            pair: 'SOL',
            quoteMint: solMint.toBase58(),
            decimals: tokenDecimals
        };
    }

    /**
     * Helper to get current SOL price in USD (USDC) from Raydium
     */
    private async getSolUsdPrice(): Promise<number | null> {
        try {
            const solMint = this._getSolMint();
            let priceData = await this.getRaydiumPrice(solMint, 9, true);

            // 1. Check Raydium V4
            if (priceData && (priceData.quoteMint === USDC_MINT_STR || priceData.pair === 'USDC')) {
                return priceData.price;
            }

            // 2. Fallback to Raydium CPMM (Standard V2)
            // console.log('[SolUsd Oracle] V4 failed, trying CPMM for SOL/USDC...');
            priceData = await this.getRaydiumCPMMPrice(solMint, 9);
            
            if (priceData && (priceData.quoteMint === USDC_MINT_STR || priceData.pair === 'USDC')) {
                return priceData.price;
            }

            console.warn(`[SolUsd Oracle] Failed to find SOL/USDC pool on V4 or CPMM.`);
            return null; 
        } catch (e) {
            console.error(`[SolUsd Oracle] Error fetching SOL price: ${e instanceof Error ? e.message : e}`);
            return null;
        }
    }

    // --- General Utility ---
    
    private async getMintDecimals(mint: PublicKey): Promise<number | null> {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const info = await this.connection.getAccountInfo(mint);
                if (!info || info.data.length < 45) return null;
                return info.data[44] || null; 
            } catch (e) {
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100)); 
                else return null;
            }
        }
        return null;
    }
}
