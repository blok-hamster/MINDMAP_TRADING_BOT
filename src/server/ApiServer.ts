import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { createServer, Server } from 'http';
import { TradeHistoryService } from '../services/TradeHistoryService';
import { WebSocketServer } from './WebSocketServer';
import { PaperWalletService } from '../services/PaperWalletService';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
//import { getSolBalance } from '../utils/solanaUtils';
import { BotConfig } from '../types';

export class ApiServer {
    public app: Express;
    public httpServer: Server;
    public wsServer: WebSocketServer;
    private tradeHistoryService: TradeHistoryService;
    private paperWalletService?: PaperWalletService;
    private config?: BotConfig;
    private connection: Connection;
    private readonly PORT = 3005;

    constructor(tradeHistoryService: TradeHistoryService, config?: BotConfig) {
        this.tradeHistoryService = tradeHistoryService;
        this.config = config;
        this.app = express();
        
        // Initialize connection for real balance checking
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

        // Initialize Paper Wallet if simulating
        if (config?.paper?.enabled || process.env.SIMULATING === 'true') {
            this.paperWalletService = new PaperWalletService(config?.redis?.url || process.env.REDIS_URL);
        }

        // Middleware
        this.app.use(cors());
        this.app.use(express.json());

        // Create HTTP server
        this.httpServer = createServer(this.app);
        
        // Initialize WebSocket Server
        this.wsServer = new WebSocketServer(this.httpServer);

        // Routes
        this.setupRoutes();
    }

    private setupRoutes() {
        // Health check
        this.app.get('/health', (_req: Request, res: Response) => {
            res.json({ status: 'ok', timestamp: new Date() });
        });

        // Bot Status
        this.app.get('/status', async (_req: Request, res: Response) => {
            try {
                const isSimulating = this.config?.paper?.enabled || process.env.SIMULATING === 'true';
                let walletAddress = '';
                let balance = 0;

                // Get Wallet Address from Private Key
                try {
                    if (process.env.PRIVATE_KEY) {
                        const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
                        walletAddress = keypair.publicKey.toString();
                    }
                } catch (e) {
                    console.error('Error deriving wallet address:', e);
                }

                if (isSimulating && this.paperWalletService) {
                    balance = await this.paperWalletService.getBalance('SOL');
                } else {
                    // Fetch real balance
                    if (walletAddress) {
                        try {
                            // Use utility or direct connection
                            // Using direct connection to avoid import circular deps or issues
                            balance = await this.connection.getBalance(new PublicKey(walletAddress)) / 1e9;
                        } catch (e) {
                            console.error('Error fetching real balance:', e);
                        }
                    }
                }

                res.json({
                    isSimulating,
                    walletAddress: walletAddress || 'Unknown',
                    balance,
                    timestamp: new Date()
                });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch status' });
            }
        });

        // Get Stats
        this.app.get('/stats', async (req: Request, res: Response) => {
            try {
                const { agentId } = req.query;
                const stats = await this.tradeHistoryService.getAgentStats(
                    (agentId as string) || process.env.AGENT_ID || 'default_agent'
                );
                res.json(stats);
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch stats' });
            }
        });

        // Get Trades (Paginated)
        this.app.get('/trades', async (req: Request, res: Response) => {
            try {
                const page = parseInt(req.query.page as string) || 1;
                const limit = parseInt(req.query.limit as string) || 50;
                const status = req.query.status as 'open' | 'closed' | undefined;
                const offset = (page - 1) * limit;

                const trades = await this.tradeHistoryService.queryTrades({
                    status,
                    limit,
                    offset
                });

                res.json({
                    data: trades,
                    page,
                    limit
                });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch trades' });
            }
        });

        // Get Single Trade
        this.app.get('/trades/:id', async (req: Request, res: Response) => {
            try {
                const trade = await this.tradeHistoryService.getTrade(req.params.id);
                if (!trade) {
                     res.status(404).json({ error: 'Trade not found' });
                     return;
                }
                res.json(trade);
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch trade' });
            }
        });
    }

    public start() {
        this.httpServer.listen(this.PORT, '0.0.0.0', () => {
            console.log(`🚀 Trading Bot API & WebSocket Server running on port ${this.PORT}`);
        });
    }
}
