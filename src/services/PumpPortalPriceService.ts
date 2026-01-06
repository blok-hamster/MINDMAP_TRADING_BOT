
import WebSocket from 'ws';
import { EventEmitter } from 'events';

interface PumpPortalTrade {
    signature: string;
    mint: string;
    traderPublicKey: string;
    txType: 'buy' | 'sell' | 'create';
    tokenAmount: number;
    solAmount: number;
    newTokenBalance?: number;
    bondingCurveKey?: string;
    vTokensInBondingCurve?: number;
    vSolInBondingCurve?: number;
    marketCapSol?: number;
    pool: 'pump' | 'bonk';
}

export class PumpPortalPriceService extends EventEmitter {
    private ws: WebSocket | null = null;
    private subscriptions: Set<string> = new Set();
    private priceCache: Map<string, number> = new Map();
    private isConnected: boolean = false;
    private reconnectTimer: NodeJS.Timeout | null = null;

    constructor() {
        super();
        this.connect();
    }

    private connect() {
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
        }

        this.ws = new WebSocket('wss://pumpportal.fun/api/data');

        this.ws.on('open', () => {
            console.info('[PumpPortal] Connected to WebSocket');
            this.isConnected = true;
            this.resubscribeAll();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            } catch (err) {
                console.error('[PumpPortal] Error parsing message', err);
            }
        });

        this.ws.on('close', () => {
            console.warn('[PumpPortal] Disconnected. Reconnecting in 5s...');
            this.isConnected = false;
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.error('[PumpPortal] WebSocket error', err);
        });
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    }

    private resubscribeAll() {
        if (!this.isConnected || this.subscriptions.size === 0) return;
        
        // PumpPortal allows array of keys
        const keys = Array.from(this.subscriptions);
        // Batch in sizes of 50 just in case
        for (let i = 0; i < keys.length; i += 50) {
            const batch = keys.slice(i, i + 50);
            this.ws?.send(JSON.stringify({
                method: "subscribeTokenTrade",
                keys: batch
            }));
        }
    }

    public subscribeToToken(mint: string) {
        if (this.subscriptions.has(mint)) return;
        
        this.subscriptions.add(mint);
        if (this.isConnected) {
            this.ws?.send(JSON.stringify({
                method: "subscribeTokenTrade",
                keys: [mint]
            }));
        }
    }

    private handleMessage(data: any) {
        // If it's a trade or create event
        if (data.txType && data.mint) {
            this.updatePriceFromEvent(data as PumpPortalTrade);
        }
    }

    private updatePriceFromEvent(event: PumpPortalTrade) {
        let price = 0;

        // Strategy 1: Virtual Reserves (Most Accurate)
        if (event.vSolInBondingCurve && event.vTokensInBondingCurve) {
            price = event.vSolInBondingCurve / event.vTokensInBondingCurve;
        }
        // Strategy 2: Transaction Implied Price
        else if (event.solAmount && event.tokenAmount) {
             price = event.solAmount / event.tokenAmount;
        }
        // Strategy 3: Market Cap (Approximation)
        else if (event.marketCapSol) {
            // Assume standard supply 1B for most Launchpad tokens?
            // Pump.fun usually has 1B supply. Raydium LaunchLab might vary.
            // This is a rough fallback.
            price = event.marketCapSol / 1_000_000_000; 
        }

        if (price > 0) {
            // Convert to Sol if needed (It is already in SOL usually)
            this.priceCache.set(event.mint, price);
            this.emit('priceUpdate', { mint: event.mint, price });
        }
    }

    public getPrice(mint: string): number | undefined {
        return this.priceCache.get(mint);
    }

    public async waitForPrice(mint: string, timeoutMs: number = 2500): Promise<number | undefined> {
        // 1. Check cache immediately
        const cached = this.priceCache.get(mint);
        if (cached) return cached;

        // 2. Wait for update
        return new Promise((resolve) => {
            let timeout: NodeJS.Timeout;

            const listener = (data: { mint: string, price: number }) => {
                if (data.mint === mint) {
                    cleanup();
                    resolve(data.price);
                }
            };

            const cleanup = () => {
                this.removeListener('priceUpdate', listener);
                clearTimeout(timeout);
            };

            timeout = setTimeout(() => {
                this.removeListener('priceUpdate', listener);
                resolve(undefined);
            }, timeoutMs);

            this.on('priceUpdate', listener);
        });
    }
}

export const pumpPortalService = new PumpPortalPriceService();
