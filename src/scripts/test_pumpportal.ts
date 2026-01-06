
import WebSocket from 'ws';

const ws = new WebSocket('wss://pumpportal.fun/api/data');
const TOKEN_MINT = process.argv[2] || '6YxpYE2aHPF7PqPuH8J2J66vQPMwzyhMva8YVDzVbonk';

ws.on('open', function open() {
  console.log('Connected to PumpPortal WebSocket');
  
  // Subscribing to trades for the specific token
  const payload = {
      method: "subscribeTokenTrade",
      keys: [TOKEN_MINT] 
  };
  
  console.log(`Subscribing to trades for: ${TOKEN_MINT}`);
  ws.send(JSON.stringify(payload));
  
  // Also subscribe to new tokens just to see if the feed works at all
  ws.send(JSON.stringify({ method: "subscribeNewToken" })); 
});

ws.on('message', function message(data) {
  const parsed = JSON.parse(data.toString());
  console.log('\n📩 Received Data:');
  console.log(JSON.stringify(parsed, null, 2));
  
  if (parsed.mint === TOKEN_MINT) {
      console.log('🎯 TARGET TOKEN UPDATE RECEIVED!');
  }
});

ws.on('error', (err) => {
    console.error('WebSocket Error:', err);
});

ws.on('close', () => {
    console.log('Connection closed');
});
