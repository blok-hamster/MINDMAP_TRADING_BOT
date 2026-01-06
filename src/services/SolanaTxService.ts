import { SolanaTrackerSwapClient } from '../utils/solanaTrackerClient';
import { SolanaTransferService, getSolBalance, checkFeeBalance } from '../utils/solanaUtils';
import { Keypair, Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import {config} from 'dotenv';
import {SolanaPriceSDK} from "../utils/onchainPrice"
import process from 'process'
import { TradeHistoryService } from './TradeHistoryService';
import { PaperWalletService } from './PaperWalletService';
import { ILogger } from './LoggerService';

config();

interface PerformSwapOptions {
    fromToken: string;
    toToken: string;
    amount: number;
    slippage: number;
    payer: string;
    priorityFee: number;
}

export interface WatchConfig {
    takeProfitPercentage?: number;
    stopLossPercentage?: number;
    trailingStopPercentage?: number;
    maxHoldTimeMinutes?: number;
    enableTrailingStop?: boolean; // Used to toggle TS on creation
}

export class AgentLedgerTools {

    private connection: Connection;
    private swapClient: SolanaTrackerSwapClient;
    private transferService: SolanaTransferService; 
    private keyPair: Keypair;
    private priceSDK: SolanaPriceSDK;
    private tradeHistoryService: TradeHistoryService;
    private paperWalletService: PaperWalletService;
    private logger?: ILogger;

    constructor(logger?: ILogger) {
        this.logger = logger;
        this.connection = new Connection(process.env.SOLANA_RPC_URL!);
        // ... (rest of constructor is the same, just keeping it valid)
        this.swapClient = new SolanaTrackerSwapClient({apiKey: process.env.SOLANA_TRACKER_API_KEY!, rpcUrl: process.env.SOLANA_RPC_URL!, privateKey: process.env.PRIVATE_KEY!});
        this.keyPair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
        this.transferService = new SolanaTransferService(process.env.SOLANA_RPC_URL!, this.keyPair);
        this.priceSDK = new SolanaPriceSDK(process.env.SOLANA_RPC_URL!);
        this.tradeHistoryService = new TradeHistoryService(process.env.REDIS_URL!);
        this.paperWalletService = new PaperWalletService(process.env.REDIS_URL!);
        
        // Initialize paper wallet if simulating
        if (process.env.SIMULATING === 'true') {
            this.paperWalletService.initializeWallet(parseFloat(process.env.PAPER_TRADING_INITIAL_SOL || '10'));
        }
    }

    private lastPriorityFee: number = 0;
    private lastPriorityFeeTime: number = 0;
    private readonly PRIORITY_FEE_CACHE_TTL_MS = 5000; // 5 seconds

    /**
     * Calculates a dynamic priority fee based on recent network activity.
     * Queries the recent prioritization fees and uses the 75th percentile
     * to ensure transaction inclusion probability.
     * @returns The calculated priority fee in SOL
     */
    async getDynamicPriorityFee(): Promise<number> {
        // Check cache
        const now = Date.now();
        if (this.lastPriorityFee > 0 && (now - this.lastPriorityFeeTime) < this.PRIORITY_FEE_CACHE_TTL_MS) {
            return this.lastPriorityFee;
        }

        try {
            // Get recent prioritization fees from the last 150 slots
            const recentFees = await this.connection.getRecentPrioritizationFees();
            
            if (!recentFees || recentFees.length === 0) {
                return 0.0005; // Fallback to default if no data
            }

            // Sort fees by slot to get the most recent ones
            recentFees.sort((a, b) => b.slot - a.slot);

            // Take the most recent 20 slots to get current network state
            const recentSamples = recentFees.slice(0, 20)
                .map(fee => fee.prioritizationFee)
                .filter(fee => fee > 0)
                .sort((a, b) => a - b);

            if (recentSamples.length === 0) {
                return 0.0005; // Fallback if no recent fees found
            }

            // Calculate 75th percentile
            const index = Math.floor(recentSamples.length * 0.75);
            const feeMicroLamports = recentSamples[index] || 5000; // Default to 5000 micro-lamports if undefined

            // Convert micro-lamports to SOL
            // 1 micro-lamport = 0.000001 lamports
            // 1 lamport = 0.000000001 SOL
            // Therefore 1 micro-lamport = 1e-15 SOL
            const feeInSol = (feeMicroLamports * 1e-6) / 1e9;
            
            // Should usually be between 0.0001 and 0.01 SOL
            // Cap it at 0.01 SOL (10M micro-lamports) to prevent excessive fees
            const cappedFee = Math.min(Math.max(feeInSol, 0.0001), 0.01);
            
            // Update cache
            this.lastPriorityFee = cappedFee;
            this.lastPriorityFeeTime = now;

            // Reduce log spam, use debug if available or skip
            if (this.logger) {
                this.logger.debug(`Calculated dynamic priority fee: ${cappedFee} SOL (${feeMicroLamports} micro-lamports) [Fresh]`);
            }
            return cappedFee;

        } catch (error) {
            if (this.logger) {
                this.logger.error('Error calculating dynamic priority fee', error as Error);
            } else {
                 console.error('Error calculating dynamic priority fee:', error);
            }
            // Return cached if available even if expired, otherwise default
            return this.lastPriorityFee > 0 ? this.lastPriorityFee : 0.0005; 
        }
    }

    //PERFORM SWAP
    //PERFORM SWAP
    async performSwap({amount, action, mint, watchConfig, prediction}:{
        amount: number, 
        action: 'buy' | 'sell', 
        mint: string, 
        watchConfig?: WatchConfig,
        prediction?: {
            taskType: string;
            classIndex?: number;
            classLabel?: string;
            probability?: number;
            confidence?: number;
            value?: number;
        }
    }) {
        try{
            const keypair = this.keyPair;
            const isSimulating = process.env.SIMULATING === 'true';

            // Validate balance
            let balanceValidation;
            if (isSimulating) {
                balanceValidation = await this.validateTradeBalanceMock({amount, action, mint});
            } else {
                balanceValidation = await this.validateTradeBalance({amount, action, mint});
            }

            if (!balanceValidation.success) {
                return {
                    success: false,
                    message: balanceValidation.message,
                    data: null
                }
            }

            // Handle simulation execution
            if (isSimulating) {
                return await this.performSwapMock({
                    amount: balanceValidation.balanceData ? balanceValidation.balanceData.available < amount && action === 'sell' ? balanceValidation.balanceData.available : amount : amount, 
                    action, 
                    mint,
                    watchConfig,
                    prediction
                });
            }

            const swapClient = this.swapClient
            //const tnxs = await this.TokenCollection.find({mint: ledger.mint, agentId: agentId});
            let totalAmount = 0;

            if(action === 'sell'){
                // Use validated balance if available, or fetch again
                if (balanceValidation.balanceData) {
                    totalAmount = balanceValidation.balanceData.available;
                } else {
                     const tokenBalance = await swapClient.getTokenBalance({mint: mint})
                     if(!tokenBalance.status || !tokenBalance.data){
                        totalAmount = 0
                     }else{
                        totalAmount = tokenBalance.data.balance;
                     }   
                }
            }else{
                totalAmount = amount;
            }

            if(totalAmount === 0){
                return {
                    success: false,
                    message: 'No token balance found',
                    data: null,
                }
            }

            const priorityFee = await this.getDynamicPriorityFee();

            const swapOptions: PerformSwapOptions = {
                fromToken: action === 'buy' ? 'So11111111111111111111111111111111111111112' : mint,
                toToken: action === 'buy' ? mint : 'So11111111111111111111111111111111111111112',
                amount: totalAmount,
                slippage: 30,
                payer: keypair.publicKey.toBase58(),
                priorityFee: priorityFee
            }

            const swapResult = await swapClient.performSwap(swapOptions);
            
            if(!swapResult.success){
                return {
                    success: false,
                    message: swapResult.message,
                    data: null,
                }
            }

            const swapResponse = swapResult.data?.swapResponse;

            // const newTransaction = {
            //     id: uuidv4(),
            //     agentId,
            //     mint,
            //     action,
            //     amountIn: swapResponse?.rate?.amountIn || 0,
            //     amountOut: swapResponse?.rate?.amountOut || 0,
            //     executionPrice: swapResponse?.rate?.executionPrice || 0,
            //     status: 'success',
            //     transactionHash: swapResult.data?.txid || '',
            //     timestamp: Date.now(),
            //     fees: swapResponse?.rate?.fee || 0,
            // }

            //await this.addTransaction(newTransaction);
            
            // Record trade in history if it's a BUY
            if (action === 'buy' && swapResult.success) {
                try {
                    // Use provided watchConfig or fall back to env vars
                    const sellConditions = {
                         takeProfitPercentage: watchConfig?.takeProfitPercentage || Number(process.env.TAKE_PROFIT_PERCENTAGE) || 20,
                         stopLossPercentage: watchConfig?.stopLossPercentage || Number(process.env.STOP_LOSS_PERCENTAGE) || 10,
                         maxHoldTimeMinutes: watchConfig?.maxHoldTimeMinutes || Number(process.env.MAX_HOLD_TIME_MINUTES) || 60,
                         trailingStopPercentage: (watchConfig?.enableTrailingStop || process.env.TRAILING_STOP_ENABLED === 'true')
                            ? (watchConfig?.trailingStopPercentage || Number(process.env.TRAILING_STOP_PERCENTAGE) || 10) 
                            : undefined,
                    };

                    await this.tradeHistoryService.createTrade({
                        agentId: process.env.AGENT_ID || 'default_agent', // Ensure AGENT_ID is in env
                        tokenMint: mint,
                        entryPrice: swapResponse?.rate?.executionPrice || 0,
                        entryAmount: swapResponse?.rate?.amountOut || 0,
                        buyTransactionId: (swapResult.data as any)?.txid || '',
                        sellConditions: sellConditions,
                        prediction: prediction // Pass prediction to trade history
                    });
                    this.logger?.info(`📝 Recorded buy trade for ${mint}`);
                } catch (historyError) {
                    this.logger?.error('Failed to record trade history:', historyError as Error);
                }
            }

            return {
                success: true,
                message: 'Swap successful',
                data: {swapResponse, entryPrice: swapResponse?.rate?.executionPrice || 0},
            }
        }catch(e:any){
            console.log(e);
            return {
                success: false,
                message: e.messaage,
                data: null
            }
        }
    }
    
    //TRANSFER SOL
    async transferSOL({to, amount}:{to: string, amount: number}) : Promise<{success: boolean, message: string, data: {transactionHash: string} | null}> {
        
       try{
        const keypair = this.keyPair;
        const swapClient = this.swapClient;
        // Todo get user balance and check if enough balance
        const userBalance = await getSolBalance(keypair.publicKey);
        if(userBalance < amount){
            return {
                success: false,
                message: 'Insufficient balance',
                data: null,
            }
        }
    
        const solanaTransferService = this.transferService;
        const transactionHash = await solanaTransferService.transferSol(to, amount);
        if(!transactionHash.success){
            const regex = /Message:\s*(.*?)\s*Logs:/s;
            const match = transactionHash.message.match(regex);
            
            
            return {
                success: false,
                message: match ? match[1] as string : transactionHash.message as string,
                data: null,
            }
        }

        const confirmation = await swapClient.checkTransactionSuccess(transactionHash.data as string)
        if(!confirmation.success){
            return {
                success: false,
                message: confirmation.error as string,
                data: null,
            }
        }

        return {
            success: true,
            message: 'SOL transfer successful',
            data: {transactionHash: transactionHash.data as string},
        }
       } catch(e){
        return {
            success: false,
            message: 'SOL transfer failed',
            data: null,
        }
       }
    }

    //TRANSFER TOKEN
    async transferToken({to, amount, mint}:{to: string, amount: number, mint: string}) : Promise<{success: boolean, message: string, data: {transactionHash: string} | null}> {
        try{
            const swapClient = this.swapClient;

            const tokenBalance = await swapClient.getTokenBalance({mint: mint})
            //console.log(tokenBalance);
            if(!tokenBalance.status){
                return {
                    success: false,
                    message: 'Token balance not found',
                    data: null,
                }
            }

            if(!tokenBalance.data){

                return {
                    success: false,
                    message: 'Token balance not found',
                    data: null,
                }
            }

            if(tokenBalance.data.balance < amount){

                return {
                    success: false,
                    message: 'Insufficient token balance',
                    data: null,
                }
            }

            const solanaTransferService = this.transferService;
            const transactionHash = await solanaTransferService.transferSplToken(mint, to, amount);
            
            //console.log(transactionHash);
            if(!transactionHash.success){
                const regex = /Message:\s*(.*?)\s*Logs:/s;
                const match = transactionHash.message.match(regex);
                
                return {
                    success: false,
                    message: match ? match[1] as string : transactionHash.message as string,
                    data: null,
                }
            }
            const confirmation = await swapClient.checkTransactionSuccess(transactionHash.data as string)
            if(!confirmation.success){
                return {
                    success: false,
                    message: confirmation.error as string,
                    data: null,
                }
            }

            return {
                success: true,
                message: 'Token transfer successful',
                data: {transactionHash: transactionHash.data as string},
            }
        } catch(e){
            this.logger?.error('Token transfer failed:', e as Error);
            return {
                success: false,
                message: 'Token transfer failed',
                data: null,
            }
        }
    }   


    // Mock mehthods for simulation

     async performSwapMock({amount, action, mint, watchConfig, prediction}:{
        amount: number, 
        action: 'buy' | 'sell', 
        mint: string, 
        watchConfig?: WatchConfig,
        prediction?: {
            taskType: string;
            classIndex?: number;
            classLabel?: string;
            probability?: number;
            confidence?: number;
            value?: number;
        }
    }) {
        void watchConfig; // Silence unused variable warning
        try{
            if(amount === 0){
                return {
                    success: false,
                    message: 'Amount must be greater than 0',
                    data: null,
                }
            }

            // 1. Get real price
            const tokenPriceInfo = await this.priceSDK.getTokenPrice(mint)
            if (!tokenPriceInfo) {
                 return {
                    success: false,
                    message: 'Could not fetch token price for simulation',
                    data: null,
                }
            }

            const currentPrice = tokenPriceInfo.price;
            const mockFee = 0.000005; // Mock network fee
            
            let amountIn = 0;
            let amountOut = 0;

            // 2. Execute Paper Trade
            if (action === 'buy') {
                // Buying Token with SOL
                // Check Paper SOL Balance
                const solBalance = await this.paperWalletService.getBalance('SOL');
                if (solBalance < amount + mockFee) {
                     return {
                        success: false,
                        message: `Insufficient Paper SOL. Required: ${amount}, Available: ${solBalance}`,
                        data: null,
                    }
                }

                // Deduct SOL, Add Token
                await this.paperWalletService.withdraw('SOL', amount + mockFee);
                amountIn = amount;
                amountOut = amount / currentPrice; // Simple version, ignoring advanced bounding curve math for now
                await this.paperWalletService.deposit(mint, amountOut);
                
                this.logger?.info(`📝 [PAPER TRADE] BUY ${mint}: -${amount} SOL, +${amountOut} Tokens @ $${currentPrice}`);

            } else {
                // Selling Token for SOL
                // Check Paper Token Balance
                const tokenBalance = await this.paperWalletService.getBalance(mint);
                // Allow small precision error tolerance or assume 'amount' is what we want to sell
                // Using 1e-9 tolerance for float inconsistencies
                if (tokenBalance < amount - 1e-9) {
                     return {
                        success: false,
                        message: `Insufficient Paper Token Balance. Required: ${amount}, Available: ${tokenBalance}`,
                        data: null,
                    }
                }

                // Deduct Token, Add SOL
                await this.paperWalletService.withdraw(mint, amount);
                amountIn = amount;
                amountOut = amount * currentPrice; 
                await this.paperWalletService.deposit('SOL', amountOut - mockFee);
                
                this.logger?.info(`📝 [PAPER TRADE] SELL ${mint}: -${amount} Tokens, +${amountOut} SOL @ $${currentPrice}`);
            }

            const swapResult = {
                success: true,
                message: 'Paper Swap successful',
                data: {
                    swapResponse: {
                        rate: {
                            amountIn: amountIn,
                            amountOut: amountOut,
                            minAmountOut: amountOut * 0.99, // 1% slippage mock
                            currentPrice: currentPrice,
                            executionPrice: currentPrice,
                            priceImpact: 0.01,
                            fee: mockFee,
                            quoteCurrency: action === 'buy' ? {mint: mint}:{mint:'So11111111111111111111111111111111111111112'},
                            baseCurrency: action === 'buy' ? {mint: 'So11111111111111111111111111111111111111112'} : {mint: mint},
                            platformFee: 0,
                            platformFeeUI: 0
                        },
                        txid: `sim_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`
                    },
                    txid: `sim_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`
                }
            }

            const swapResponse = swapResult.data?.swapResponse;
            
             // Record trade in history if it's a BUY
            if (action === 'buy' && swapResult.success) {
                try {
                    // Use provided watchConfig or fall back to env vars
                    const sellConditions = {
                         takeProfitPercentage: watchConfig?.takeProfitPercentage || Number(process.env.TAKE_PROFIT_PERCENTAGE) || 20,
                         stopLossPercentage: watchConfig?.stopLossPercentage || Number(process.env.STOP_LOSS_PERCENTAGE) || 10,
                         maxHoldTimeMinutes: watchConfig?.maxHoldTimeMinutes || Number(process.env.MAX_HOLD_TIME_MINUTES) || 60,
                         trailingStopPercentage: (watchConfig?.enableTrailingStop || process.env.TRAILING_STOP_ENABLED === 'true')
                            ? (watchConfig?.trailingStopPercentage || Number(process.env.TRAILING_STOP_PERCENTAGE) || 10) 
                            : undefined,
                    };

                    await this.tradeHistoryService.createTrade({
                        agentId: process.env.AGENT_ID || 'default_agent', // Ensure AGENT_ID is in env
                        tokenMint: mint,
                        entryPrice: swapResponse?.rate?.executionPrice || 0,
                        entryAmount: swapResponse?.rate?.amountOut || 0,
                        buyTransactionId: (swapResult.data as any)?.txid || '',
                        sellConditions: sellConditions,
                        prediction: prediction, // Pass prediction to trade history
                        isSimulation: true
                    });
                    this.logger?.info(`📝 Recorded PAPER buy trade for ${mint}`);
                } catch (historyError) {
                    this.logger?.error('Failed to record PAPER trade history:', historyError as Error);
                }
            }

            return {
                success: true,
                message: 'Paper Swap successful',
                data: {swapResponse, entryPrice: swapResponse?.rate?.executionPrice || 0},
            }
        }catch(e:any){
            console.log(e);
            return {
                success: false,
                message: e.message,
                data: null,
            }
        }
    }

    /**
     * Validate balance before executing trade
     */
    async validateTradeBalance({amount, action, mint}:{amount: number, action: 'buy' | 'sell', mint: string}): Promise<{
        success: boolean;
        message: string;
        balanceData?: any;
    }> {
        try {
            // Check basic fee balance
            const hasFeeBalance = await checkFeeBalance(this.keyPair.publicKey);
            if (!hasFeeBalance) {
                 return {
                    success: false,
                    message: 'Insufficient SOL balance for transaction fees. Minimum 0.001 SOL required.',
                };
            }

            if (action === 'buy') {
                const balanceInSol = await getSolBalance(this.keyPair.publicKey);
                
                if (balanceInSol < amount) {
                    return {
                        success: false,
                        message: `Insufficient SOL balance for buy trade. Required: ${amount} SOL, Available: ${balanceInSol.toFixed(4)} SOL`,
                        balanceData: { available: balanceInSol, required: amount }
                    };
                }

                return {
                    success: true,
                    message: `Balance validated. Available: ${balanceInSol.toFixed(4)} SOL`,
                    balanceData: { available: balanceInSol, required: amount }
                };
            } else if (action === 'sell') {
                const tokenBalance = await this.swapClient.getTokenBalance({ mint });
                
                if (!tokenBalance.status || !tokenBalance.data || tokenBalance.data.balance === 0) {
                     const availableBalance = tokenBalance.data?.balance || 0;
                     return {
                        success: false,
                        message: `Insufficient token balance for sell trade. Required: ${amount}, Available: ${availableBalance}`,
                        balanceData: { available: availableBalance, required: amount, tokenMint: mint }
                    };
                }

                return {
                    success: true,
                    message: `Token balance validated. Available: ${tokenBalance.data.balance}`,
                    balanceData: { available: tokenBalance.data.balance, required: amount, tokenMint: mint }
                };
            }

            return { success: true, message: 'Balance validated' };

        } catch (error) {
            this.logger?.error('Error validating trade balance:', error as Error);
            return {
                success: false,
                message: `Balance validation failed: ${(error as Error).message}`,
            };
        }
    }

    async validateTradeBalanceMock({amount, action, mint}:{amount: number, action: 'buy' | 'sell', mint: string}): Promise<{
        success: boolean;
        message: string;
        balanceData?: any;
    }> {
        try {
            if (action === 'buy') {
                const solBalance = await this.paperWalletService.getBalance('SOL');
                if (solBalance < amount) {
                    return {
                        success: false,
                        message: `Insufficient Paper SOL. Required: ${amount}, Available: ${solBalance}`,
                        balanceData: { available: solBalance, required: amount }
                    };
                }
                 return {
                    success: true,
                    message: `Paper Balance validated. Available: ${solBalance}`,
                    balanceData: { available: solBalance, required: amount }
                };
            } else {
                const tokenBalance = await this.paperWalletService.getBalance(mint);
                // Allow slightly fuzzy comparison for floating point errors
                if (tokenBalance < amount - 1e-9) {
                    return {
                        success: false,
                        message: `Insufficient Paper Token Balance. Required: ${amount}, Available: ${tokenBalance}`,
                        balanceData: { available: tokenBalance, required: amount }
                    };
                }
                return {
                    success: true,
                    message: `Paper Token Balance validated. Available: ${tokenBalance}`,
                    balanceData: { available: tokenBalance, required: amount }
                };
            }
        } catch (error) {
             return {
                success: false,
                message: `Paper Balance validation failed: ${(error as Error).message}`,
            };
        }
    }
    
}