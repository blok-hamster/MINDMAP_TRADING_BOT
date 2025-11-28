# Configuration Guide

This document provides detailed information about configuring the KOL Mindmap Trading Bot.

## Configuration Sources

The bot supports two configuration sources with the following precedence:

1. **Environment Variables** (highest priority)
2. **config.json file** (lower priority)
3. **Default values** (fallback)

## Quick Start

1. Copy the example files:
   ```bash
   cp .env.example .env
   cp config.example.json config.json
   ```

2. Edit `.env` or `config.json` with your values

3. Start the bot - it will automatically load and validate the configuration

## Configuration Options

### API Configuration

**serverUrl** (required)
- Description: URL of the API server providing WebSocket and HTTP endpoints
- Environment Variable: `API_SERVER_URL`
- Default: `http://localhost:3000`
- Example: `https://api.example.com`

**apiKey** (required)
- Description: API key for authentication with the server
- Environment Variable: `API_KEY`
- Default: None (must be provided)
- Example: `sk_live_abc123xyz789`

### Redis Configuration

**url** (required)
- Description: Redis connection URL for caching and state management
- Environment Variable: `REDIS_URL`
- Default: `redis://localhost:6379`
- Format: `redis://[username:password@]host:port[/database]`
- Example: `redis://user:pass@localhost:6379/0`

### Monitoring Configuration

**mode** (required)
- Description: Determines which KOL wallets to monitor
- Environment Variable: `MONITORING_MODE`
- Default: `subscribed`
- Options:
  - `subscribed`: Monitor only KOLs you have subscribed to
  - `all`: Monitor all available KOL wallets
- Recommendation: Use `subscribed` for focused trading, `all` for broader opportunities

### Filter Configuration

These criteria determine which tokens pass the initial filter before ML prediction.

**minTradeVolume** (required)
- Description: Minimum total trade volume across all KOL connections
- Environment Variable: `MIN_TRADE_VOLUME`
- Default: `1000`
- Unit: USD or SOL (depending on API)
- Range: 0 to infinity
- Recommendation: 500-5000 for balanced filtering

**minConnectedKOLs** (required)
- Description: Minimum number of unique KOL connections required
- Environment Variable: `MIN_CONNECTED_KOLS`
- Default: `3`
- Range: 0 to infinity
- Recommendation: 2-5 for quality signals

**minInfluenceScore** (required)
- Description: Minimum average influence score across KOL connections
- Environment Variable: `MIN_INFLUENCE_SCORE`
- Default: `50`
- Range: 0 to 100
- Recommendation: 40-70 for established KOLs

**minTotalTrades** (required)
- Description: Minimum total number of trades across all KOL connections
- Environment Variable: `MIN_TOTAL_TRADES`
- Default: `5`
- Range: 0 to infinity
- Recommendation: 3-10 for active tokens

### Risk Management Configuration

**takeProfitPercentage** (required)
- Description: Automatically sell when token price increases by this percentage
- Environment Variable: `TAKE_PROFIT_PERCENTAGE`
- Default: `50`
- Range: 1 to 1000
- Recommendation: 30-100 for memecoin volatility

**stopLossPercentage** (required)
- Description: Automatically sell when token price decreases by this percentage
- Environment Variable: `STOP_LOSS_PERCENTAGE`
- Default: `20`
- Range: 1 to 100
- Recommendation: 15-30 to limit losses

**trailingStopEnabled** (required)
- Description: Enable trailing stop loss that adjusts upward as price increases
- Environment Variable: `TRAILING_STOP_ENABLED`
- Default: `true`
- Options: `true` or `false`
- Recommendation: `true` to lock in profits

### Trading Configuration

**buyAmount** (required)
- Description: Amount of SOL to spend on each token purchase
- Environment Variable: `BUY_AMOUNT`
- Default: `0.1`
- Unit: SOL
- Range: > 0
- Recommendation: 0.05-0.5 depending on risk tolerance and capital

### Logging Configuration

**level** (required)
- Description: Minimum log level to output
- Environment Variable: `LOG_LEVEL`
- Default: `info`
- Options:
  - `debug`: All logs including detailed debugging information
  - `info`: General information about bot operations
  - `warn`: Warning messages and important events
  - `error`: Only error messages
- Recommendation: `info` for production, `debug` for troubleshooting

## Configuration Examples

### Conservative Configuration
```json
{
  "filter": {
    "minTradeVolume": 5000,
    "minConnectedKOLs": 5,
    "minInfluenceScore": 70,
    "minTotalTrades": 10
  },
  "risk": {
    "takeProfitPercentage": 30,
    "stopLossPercentage": 15,
    "trailingStopEnabled": true
  },
  "trading": {
    "buyAmount": 0.05
  }
}
```

### Aggressive Configuration
```json
{
  "filter": {
    "minTradeVolume": 500,
    "minConnectedKOLs": 2,
    "minInfluenceScore": 40,
    "minTotalTrades": 3
  },
  "risk": {
    "takeProfitPercentage": 100,
    "stopLossPercentage": 30,
    "trailingStopEnabled": true
  },
  "trading": {
    "buyAmount": 0.2
  }
}
```

### Balanced Configuration (Default)
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

## Validation Rules

The bot validates all configuration values on startup:

### Required Fields
- All configuration sections must be present
- API key and server URL must be provided
- Redis URL must be provided

### Value Ranges
- Filter values must be non-negative
- Influence score must be 0-100
- Take profit percentage must be 1-1000
- Stop loss percentage must be 1-100
- Buy amount must be greater than zero
- Log level must be one of: debug, info, warn, error
- Monitoring mode must be: all or subscribed

### Warnings
The bot will log warnings for values outside recommended ranges:
- Very low trade volume (< 100)
- Very few connected KOLs (< 2)
- Low influence score (< 30)
- Low take profit (< 20%)
- High stop loss (> 50%)
- High buy amount (> 1 SOL)

## Hot Reloading

The bot supports hot-reloading of filter and risk management parameters without restart. This feature will be implemented in future versions.

## Environment Variables vs Config File

**Use Environment Variables when:**
- Deploying to production environments
- Using container orchestration (Docker, Kubernetes)
- Managing secrets securely
- Different configurations per environment

**Use Config File when:**
- Local development
- Quick configuration changes
- Sharing configuration templates
- Version controlling non-sensitive settings

## Troubleshooting

### Configuration Not Loading
- Check that config.json is valid JSON
- Verify file permissions
- Check console for error messages

### Validation Errors
- Review error messages on startup
- Ensure all required fields are present
- Verify value ranges are correct

### Environment Variables Not Working
- Ensure variables are exported in shell
- Check variable names match exactly
- Restart bot after changing environment

## Security Best Practices

1. **Never commit .env or config.json with real credentials**
2. **Use environment variables for sensitive data in production**
3. **Rotate API keys regularly**
4. **Use Redis password authentication**
5. **Restrict file permissions on config files**
   ```bash
   chmod 600 .env config.json
   ```
