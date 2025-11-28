# KOL Mindmap Trading Bot

An autonomous Solana memecoin trading bot that leverages KOL (Key Opinion Leader) mindmap data to identify and execute profitable trades. The bot monitors real-time KOL trading activity, filters tokens using configurable criteria, validates opportunities with ML predictions, and executes trades with built-in risk management.

## Features

- **Real-time WebSocket Integration**: Connects to API server for live KOL trade and mindmap updates
- **Intelligent Filtering**: Configurable criteria for evaluating tokens based on volume, KOL connections, and influence scores
- **ML-Powered Predictions**: Validates trading opportunities using machine learning models
- **Risk Management**: Built-in take profit, stop loss, and trailing stop functionality
- **Redis Caching**: Efficient data caching with automatic TTL management
- **Duplicate Prevention**: Tracks processed tokens to avoid duplicate purchases
- **Comprehensive Logging**: Detailed operation logs for monitoring and troubleshooting
- **Graceful Shutdown**: Proper cleanup of connections and resources

## Prerequisites

- Node.js 18.x or higher
- Redis server (local or remote)
- API server with WebSocket and HTTP endpoints
- Valid API key for authentication

## Installation

1. **Clone or navigate to the trading_bot directory**

```bash
cd trading_bot
```

2. **Install dependencies**

```bash
npm install
```

3. **Configure environment variables**

Copy the example environment file and edit with your settings:

```bash
cp .env.example .env
```

Edit `.env` with your configuration (see Configuration section below).

4. **Configure bot settings (optional)**

Copy the example config file and customize:

```bash
cp config.example.json config.json
```

Edit `config.json` to adjust filter criteria and risk management settings.

5. **Build the application**

```bash
npm run build
```

## Configuration

The bot supports configuration through both environment variables and a JSON config file. Environment variables take precedence over config file settings.

### Environment Variables (.env)

```bash
# API Configuration
API_SERVER_URL=http://localhost:3000
API_KEY=your_api_key_here

# Redis Configuration
REDIS_URL=redis://localhost:6379

# Bot Configuration
MONITORING_MODE=subscribed  # 'subscribed' or 'all'
LOG_LEVEL=info              # 'debug', 'info', 'warn', 'error'

# Filter Configuration (optional - can be set in config.json)
MIN_TRADE_VOLUME=1000
MIN_CONNECTED_KOLS=3
MIN_INFLUENCE_SCORE=50
MIN_TOTAL_TRADES=5

# Trading Configuration (optional - can be set in config.json)
BUY_AMOUNT=0.1
TAKE_PROFIT_PERCENTAGE=50
STOP_LOSS_PERCENTAGE=20
TRAILING_STOP_ENABLED=true
```

### Configuration File (config.json)

```json
{
  "filter": {
    "minTradeVolume": 1000,
    "minConnectedKOLs": 3,
    "minInfluenceScore": 50,
    "minTotalTrades": 5
  },
  "risk": {
    "takeProfitPercentage": 50,
    "stopLossPercentage": 20,
    "trailingStopEnabled": true
  },
  "trading": {
    "buyAmount": 0.1
  }
}
```

### Configuration Options Explained

#### API Configuration

- **API_SERVER_URL**: Base URL of the API server (required)
- **API_KEY**: Your API key for authentication (required)

#### Redis Configuration

- **REDIS_URL**: Redis connection URL (required)
  - Format: `redis://[username:password@]host:port[/database]`
  - Example: `redis://localhost:6379` or `redis://user:pass@redis.example.com:6379/0`

#### Bot Configuration

- **MONITORING_MODE**: Determines which KOLs to monitor (required)
  - `subscribed`: Monitor only KOLs you're subscribed to
  - `all`: Monitor all available KOLs
- **LOG_LEVEL**: Logging verbosity (default: `info`)
  - `debug`: Detailed debugging information
  - `info`: General operational information
  - `warn`: Warning messages
  - `error`: Error messages only

#### Filter Configuration

These criteria determine which tokens pass the initial filter:

- **MIN_TRADE_VOLUME**: Minimum total trade volume across all KOL connections (in USD)
  - Default: 1000
  - Higher values = more selective filtering
- **MIN_CONNECTED_KOLS**: Minimum number of unique KOLs trading the token
  - Default: 3
  - More KOLs = stronger signal
- **MIN_INFLUENCE_SCORE**: Minimum average influence score across KOL connections
  - Default: 50
  - Range: 0-100
- **MIN_TOTAL_TRADES**: Minimum total number of trades across all KOLs
  - Default: 5
  - More trades = more established activity

#### Trading Configuration

- **BUY_AMOUNT**: Amount to spend per trade (in SOL)
  - Default: 0.1
  - Adjust based on your risk tolerance and capital

#### Risk Management Configuration

- **TAKE_PROFIT_PERCENTAGE**: Percentage gain to trigger automatic sell
  - Default: 50 (50% profit)
  - Range: 1-1000
- **STOP_LOSS_PERCENTAGE**: Percentage loss to trigger automatic sell
  - Default: 20 (20% loss)
  - Range: 1-100
- **TRAILING_STOP_ENABLED**: Enable trailing stop loss
  - Default: true
  - When enabled, stop loss adjusts upward as price increases

## Usage

### Development Mode

Run the bot with auto-reload on code changes:

```bash
npm run dev
```

### Production Mode

Build and run the bot:

```bash
npm run build
npm start
```

### Monitoring

The bot logs all operations to:
- Console output (stdout/stderr)
- Log files in `logs/` directory (if configured)

Monitor the logs to track:
- WebSocket connection status
- Tokens evaluated and filter results
- ML prediction scores
- Trade executions and results
- Errors and warnings

### Stopping the Bot

Press `Ctrl+C` to initiate graceful shutdown. The bot will:
1. Close WebSocket connection
2. Disconnect from Redis
3. Flush pending logs
4. Exit cleanly

## How It Works

### 1. Initialization

- Loads configuration from environment and config file
- Connects to Redis for caching
- Establishes WebSocket connection to API server
- Subscribes to KOL trade updates based on monitoring mode

### 2. Data Reception

The bot receives two types of WebSocket events:

- **mindmap_update**: Complete mindmap data for a token
  - Cached in Redis with 30-minute TTL
  - Triggers token evaluation if not already processed

- **kol_trade_update**: Real-time KOL trade events
  - Updates cached mindmap data with new trade information
  - Recalculates volume, KOL count, and influence scores
  - May trigger re-evaluation if metrics improve

### 3. Token Evaluation Pipeline

For each token, the bot executes a three-stage pipeline:

#### Stage 1: Mindmap Filtering
- Calculates total trade volume across all KOL connections
- Counts unique KOLs trading the token
- Calculates average influence score
- Compares metrics against configured thresholds
- **Result**: Pass or reject with detailed metrics

#### Stage 2: ML Prediction
- Calls prediction API with token mint address
- Receives confidence score (0-100%)
- Applies 69% confidence threshold
- **Result**: Approve or reject based on confidence

#### Stage 3: Trade Execution
- Checks if token was already purchased (duplicate prevention)
- Calls swap API with buy amount and risk parameters
- Marks token as processed on success
- Deletes mindmap cache to prevent re-evaluation
- **Result**: Transaction signature or error

### 4. Cache Management

- **Mindmap Data**: Cached for 30 minutes, updated on new trades
- **Processed Tokens**: Tracked to prevent duplicate purchases
- **Automatic Cleanup**: Mindmap data deleted after successful purchase

## Troubleshooting

### Bot won't start

- Check that all required environment variables are set
- Verify Redis is running and accessible
- Confirm API server is reachable
- Check API key is valid

### WebSocket connection fails

- Verify API_SERVER_URL is correct
- Check API_KEY is valid
- Ensure API server WebSocket endpoint is accessible
- Review logs for specific error messages

### No trades executing

- Check filter criteria aren't too restrictive
- Verify monitoring mode is correct (subscribed vs all)
- Confirm you have subscriptions if using 'subscribed' mode
- Review logs to see why tokens are being rejected

### Redis connection errors

- Verify Redis server is running
- Check REDIS_URL format is correct
- Ensure Redis is accessible from bot's network
- Check Redis authentication if required

### Trade execution failures

- Verify sufficient SOL balance in wallet
- Check BUY_AMOUNT isn't too large
- Review API server logs for swap errors
- Ensure token is tradeable (liquidity, not frozen)

## Project Structure

```
trading_bot/
├── src/
│   ├── config/
│   │   └── ConfigManager.ts       # Configuration loading and validation
│   ├── core/
│   │   ├── BotCoreEngine.ts       # Main orchestration logic
│   │   └── MindmapFilterEngine.ts # Token filtering logic
│   ├── services/
│   │   ├── CacheService.ts        # Redis caching operations
│   │   ├── HttpClient.ts          # API HTTP requests
│   │   ├── LoggerService.ts       # Logging functionality
│   │   ├── PredictionService.ts   # ML prediction integration
│   │   ├── TradeExecutor.ts       # Trade execution logic
│   │   └── WebSocketManager.ts    # WebSocket connection management
│   ├── types/
│   │   └── index.ts               # TypeScript type definitions
│   ├── utils/
│   │   └── ErrorHandler.ts        # Error handling utilities
│   └── index.ts                   # Application entry point
├── logs/                          # Log files (created at runtime)
├── .env                           # Environment variables (create from .env.example)
├── .env.example                   # Example environment variables
├── config.json                    # Bot configuration (create from config.example.json)
├── config.example.json            # Example configuration
├── package.json                   # Dependencies and scripts
├── tsconfig.json                  # TypeScript configuration
└── README.md                      # This file
```

## Security Best Practices

1. **Never commit .env or config.json** - These contain sensitive credentials
2. **Use strong API keys** - Generate secure, unique keys
3. **Secure Redis** - Use password authentication for Redis
4. **Monitor logs** - Regularly review logs for suspicious activity
5. **Limit permissions** - Use API keys with minimal required permissions
6. **Network security** - Use VPN or private networks when possible

## Disclaimer

This bot is for educational and research purposes. Cryptocurrency trading carries significant risk. Always:

- Start with small amounts
- Test thoroughly in development environments
- Monitor bot operations closely
- Understand the risks of automated trading
- Never invest more than you can afford to lose

The developers are not responsible for any financial losses incurred through use of this software.
