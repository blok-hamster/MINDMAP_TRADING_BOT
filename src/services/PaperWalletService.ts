import { createClient, RedisClientType } from 'redis';
import { config } from 'dotenv';

config();

export class PaperWalletService {
    private redis: RedisClientType;
    private readonly BALANCE_KEY = 'paper_wallet:balance';
    private readonly INITIAL_BALANCE_KEY = 'paper_wallet:initialized';

    constructor(redisUrl?: string) {
        const url = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
        this.redis = createClient({ url });

        this.redis.on('error', (err) => console.error('❌ Redis Client Error (PaperWallet):', err));
        this.redis.connect().catch(console.error);
    }

    async ensureConnected(): Promise<void> {
        if (!this.redis.isOpen) {
            await this.redis.connect();
        }
    }

    /**
     * Initialize wallet with default SOL if not already initialized
     */
    async initializeWallet(initialSol: number = 10): Promise<void> {
        await this.ensureConnected();
        const isInitialized = await this.redis.get(this.INITIAL_BALANCE_KEY);
        
        if (!isInitialized) {
            console.log(`🆕 Initializing Paper Wallet with ${initialSol} SOL`);
            await this.redis.hSet(this.BALANCE_KEY, 'SOL', initialSol.toString());
            await this.redis.set(this.INITIAL_BALANCE_KEY, 'true');
        }
    }

    /**
     * Get balance for a specific token (or SOL)
     */
    async getBalance(mint: string): Promise<number> {
        await this.ensureConnected();
        const balance = await this.redis.hGet(this.BALANCE_KEY, mint);
        return balance ? parseFloat(balance) : 0;
    }

    /**
     * Get all balances
     */
    async getAllBalances(): Promise<Record<string, number>> {
        await this.ensureConnected();
        const balances = await this.redis.hGetAll(this.BALANCE_KEY);
        const result: Record<string, number> = {};
        
        for (const [mint, amount] of Object.entries(balances)) {
            result[mint] = parseFloat(amount);
        }
        return result;
    }

    /**
     * Deposit funds (add to balance)
     */
    async deposit(mint: string, amount: number): Promise<number> {
        await this.ensureConnected();
        const currentCheck = await this.redis.hGet(this.BALANCE_KEY, mint);
        const current = currentCheck ? parseFloat(currentCheck) : 0;
        const newBalance = current + amount;
        
        await this.redis.hSet(this.BALANCE_KEY, mint, newBalance.toString());
        return newBalance;
    }

    /**
     * Withdraw funds (subtract from balance)
     * Throws error if insufficient funds
     */
    async withdraw(mint: string, amount: number): Promise<number> {
        await this.ensureConnected();
        const currentCheck = await this.redis.hGet(this.BALANCE_KEY, mint);
        const current = currentCheck ? parseFloat(currentCheck) : 0; // Default to 0 instead of erroring if not found, logic handled below

        if (current < amount) {
            throw new Error(`Insufficient paper funds for ${mint}. Required: ${amount}, Available: ${current}`);
        }

        const newBalance = current - amount;
        await this.redis.hSet(this.BALANCE_KEY, mint, newBalance.toString());
        return newBalance;
    }

    /**
     * Reset wallet to initial state
     */
    async resetWallet(initialSol: number = 10): Promise<void> {
        await this.ensureConnected();
        console.log('🔄 Resetting Paper Wallet');
        await this.redis.del(this.BALANCE_KEY);
        await this.redis.hSet(this.BALANCE_KEY, 'SOL', initialSol.toString());
        await this.redis.set(this.INITIAL_BALANCE_KEY, 'true');
    }
}
