import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';

export class WebSocketServer {
    private io: SocketIOServer;
    private readonly CORS_ORIGIN = "*"; // Allow all for dev, restrict in prod

    constructor(httpServer: HttpServer) {
        this.io = new SocketIOServer(httpServer, {
            cors: {
                origin: this.CORS_ORIGIN,
                methods: ["GET", "POST"]
            }
        });

        this.io.on('connection', (socket: Socket) => {
            console.log('🔌 Client connected to WebSocket:', socket.id);
            
            socket.on('disconnect', () => {
                console.log('🔌 Client disconnected:', socket.id);
            });
        });
    }

    /**
     * Broadcast a trade update (open/close/update)
     */
    public broadcastTradeUpdate(trade: any) {
        this.io.emit('trade_update', trade);
    }

    /**
     * Broadcast a price update for a token
     */
    public broadcastPriceUpdate(data: { mint: string, price: number }) {
        this.io.emit('price_update', data);
    }
}
