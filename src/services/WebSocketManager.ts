import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import { KOLTradeUpdateEvent, MindmapUpdateEvent } from '../types';
import { ErrorHandler } from '../utils/ErrorHandler';

/**
 * WebSocket configuration
 */
export interface WebSocketConfig {
  serverUrl: string;
  apiKey: string;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
}

/**
 * WebSocket Manager interface
 */
export interface IWebSocketManager {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(kols: string[]): void;
  on(event: string, handler: Function): void;
  isConnected(): boolean;
}

/**
 * WebSocket Manager implementation
 * Manages WebSocket connection lifecycle and event handling
 */
export class WebSocketManager extends EventEmitter implements IWebSocketManager {
  private socket: Socket | null = null;
  private apiKey: string;
  private serverUrl: string;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private isReconnecting: boolean = false;
  private shouldReconnect: boolean = true;
  private logger?: any;

  constructor(config: WebSocketConfig, logger?: any) {
    super();
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;
    this.reconnectDelay = config.reconnectDelay || 1000;
    this.logger = logger;
  }

  /**
   * Establish WebSocket connection with API key authentication
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Initialize Socket.IO client with API key authentication
        this.socket = io(this.serverUrl, {
          auth: {
            apiKey: this.apiKey
          },
          extraHeaders: {
            'x-api-key': this.apiKey
          },
          transports: ['websocket', 'polling'],
          reconnection: false // We'll handle reconnection manually
        });

        // Set up event handlers
        this.setupEventHandlers();

        // Wait for connection
        this.socket.once('connect', () => {
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          resolve();
        });

        this.socket.once('connect_error', (error) => {
          reject(new Error(`WebSocket connection failed: ${error.message}`));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect WebSocket connection
   */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Subscribe to KOL trade updates
   */
  subscribe(kols: string[]): void {
    if (!this.socket || !this.socket.connected) {
      throw new Error('WebSocket is not connected. Call connect() first.');
    }

    this.socket.emit('subscribe_kol_trades', { kols });
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.socket !== null && this.socket.connected;
  }

  /**
   * Set up event handlers for WebSocket events
   */
  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Connection events
    this.socket.on('connect', () => this.handleConnect());
    this.socket.on('disconnect', (reason) => this.handleDisconnect(reason));
    this.socket.on('connect_error', (error) => this.handleError(error));

    // Data events
    this.socket.on('kol_trade_update', (data: KOLTradeUpdateEvent) =>{
      //console.log('Received KOL trade update:', data) // Temporary log for debugging purposes
      this.handleKOLTradeUpdate(data)
    });
    this.socket.on('mindmap_update', (data: MindmapUpdateEvent) => {
      //console.log('Received mindmap update:', data) // Temporary log for debugging purposes
      this.handleMindmapUpdate(data)
    });
  }

  /**
   * Handle successful connection
   */
  private handleConnect(): void {
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.logger?.info('WebSocket connected successfully');
    this.emit('connected');
  }

  /**
   * Handle disconnection
   */
  private handleDisconnect(reason: string): void {
    this.logger?.warn('WebSocket disconnected', { reason });
    this.emit('disconnected', reason);

    // Attempt reconnection if not intentional disconnect
    if (this.shouldReconnect && reason !== 'io client disconnect') {
      this.logger?.info('Attempting to reconnect WebSocket');
      this.reconnectWithBackoff();
    }
  }

  /**
   * Handle connection errors
   */
  private handleError(error: Error): void {
    const isRecoverable = ErrorHandler.handleWebSocketError(error, this.logger);
    
    this.emit('error', {
      error,
      isRecoverable
    });

    // If error is recoverable and we should reconnect, trigger reconnection
    if (isRecoverable && this.shouldReconnect && !this.isReconnecting) {
      this.logger?.info('WebSocket error is recoverable, will attempt reconnection');
      this.reconnectWithBackoff();
    }
  }

  /**
   * Handle KOL trade update events
   */
  private handleKOLTradeUpdate(data: KOLTradeUpdateEvent): void {
    this.emit('kol_trade_update', data);
  }

  /**
   * Handle mindmap update events
   */
  private handleMindmapUpdate(data: MindmapUpdateEvent): void {
    this.emit('mindmap_update', data);
  }

  /**
   * Reconnect with exponential backoff strategy
   */
  private reconnectWithBackoff(): void {
    if (this.isReconnecting) return;
    
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger?.error('Max WebSocket reconnection attempts reached', {
        attempts: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts
      });
      this.emit('max_reconnect_attempts_reached');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Calculate delay with exponential backoff using ErrorHandler
    const actualDelay = ErrorHandler.calculateBackoffDelay(
      this.reconnectAttempts - 1,
      this.reconnectDelay,
      30000, // Max 30 seconds
      2 // Exponential multiplier
    );

    this.logger?.info('WebSocket reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delay: actualDelay
    });

    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delay: actualDelay
    });

    setTimeout(async () => {
      try {
        this.logger?.debug('Attempting WebSocket reconnection');
        await this.connect();
      } catch (error) {
        this.logger?.error('WebSocket reconnection attempt failed', {
          attempt: this.reconnectAttempts,
          error: (error as Error).message
        });
        this.isReconnecting = false;
        // Will trigger another reconnect attempt via disconnect handler
      }
    }, actualDelay);
  }
}
