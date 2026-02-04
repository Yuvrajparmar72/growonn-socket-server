// index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Environment Variables (Ye hum Railway par set karenge)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Global Variables
let angelWS = null;
let subscriptionMap = new Map(); // Kiske paas konsa stock hai: "Exchange|Token" -> Set(SocketIDs)
let tokenDetailsMap = new Map(); // "Exchange|Token" -> { token, exchange, name }

// --- 1. Angel One Binary Parser (Apke purane code se liya gaya) ---
function parseBinary(buffer) {
    try {
        const dv = new DataView(buffer);
        if (buffer.byteLength < 51) return null;
        
        // Token nikalna
        const tokenBytes = new Uint8Array(buffer, 2, 25);
        let tokenStr = "";
        for (let i = 0; i < tokenBytes.length && tokenBytes[i] !== 0; i++) {
            tokenStr += String.fromCharCode(tokenBytes[i]);
        }
        tokenStr = tokenStr.trim();

        // Check karein kya kisi ne ye manga hai?
        // Note: Angel One binary packet me Exchange ID check karna complex hai, 
        // hum token se match karenge.
        
        // LTP (Last Traded Price) nikalna (Offset 43)
        const ltp = dv.getInt32(43, true) / 100;
        
        // Simple OHLC extraction (Basic)
        const open = dv.getInt32(59, true) / 100;
        const high = dv.getInt32(99, true) / 100;
        const low = dv.getInt32(91, true) / 100;
        const close = dv.getInt32(107, true) / 100;
        
        return { token: tokenStr, ltp, open, high, low, close };
    } catch (e) {
        return null;
    }
}

// --- 2. Angel One Connection Logic ---
async function connectToAngel() {
    try {
        console.log("Fetching credentials from Supabase...");
        // Database se latest token uthana
        const { data: config, error } = await supabase
            .from('api_config')
            .select('*')
            .single();

        if (error || !config) throw new Error("Credentials nahi mile!");

        const { feed_token, angel_client_id, angel_api_key } = config;
        
        const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${angel_client_id}&feedToken=${feed_token}&apiKey=${angel_api_key}`;
        
        console.log("Connecting to Angel One...");
        angelWS = new WebSocket(wsUrl);

        angelWS.on('open', () => {
            console.log("✅ Angel One Connected!");
            resubscribeAll(); // Agar disconnect hua tha to wapas subscribe karo
        });

        angelWS.on('message', (data) => {
            // Binary data aayega, parse karo
            if (data instanceof Buffer) {
                const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                const parsed = parseBinary(arrayBuffer);
                
                if (parsed && parsed.ltp > 0) {
                    broadcastData(parsed);
                }
            }
        });

        angelWS.on('close', () => {
            console.log("❌ Angel One Disconnected. Reconnecting in 2s...");
            setTimeout(connectToAngel, 2000);
        });

        angelWS.on('error', (err) => console.error("Angel Error:", err.message));

    } catch (err) {
        console.log("Setup Error:", err.message);
        setTimeout(connectToAngel, 5000); // Retry logic
    }
}

// --- 3. Broadcasting Logic ---
function broadcastData(data) {
    // Check karo kis user ne ye token manga tha
    // Hum simple broadcast karenge un rooms me jo token ke naam par bane hain
    // Example Room Name: "NSE:99926000"
    
    // Lekin Angel binary me exchange confirm karna mushkil hota hai bina lookup ke.
    // Isliye hum simple token ID se broadcast karenge.
    
    io.to(`TOKEN:${data.token}`).emit('market-update', {
        symbol_token: data.token,
        ltp: data.ltp,
        open_price: data.open,
        high_price: data.high,
        low_price: data.low,
        close_price: data.close,
        updated_at: new Date().toISOString()
    });
}

// --- 4. Client (Mobile App) Handling ---
io.on('connection', (socket) => {
    console.log('📱 New App Connected:', socket.id);

    socket.on('subscribe', (tokens) => {
        // Tokens example: [{ token: "99926000", exchange: "NSE" }]
        
        const tokenList = [];
        tokens.forEach(t => {
            // App ko specific room me daal do
            socket.join(`TOKEN:${t.token}`);
            
            // Angel One ko bhejne ke liye list banao
            // Exchange Codes: NSE=1, NFO=2, BSE=3
            let exCode = 1; 
            if(t.exchange === "NFO") exCode = 2;
            if(t.exchange === "BSE") exCode = 3;
            
            tokenList.push({ exchangeType: exCode, tokens: [t.token] });
        });

        // Angel One ko bolo ki inka data bheje
        if (angelWS && angelWS.readyState === WebSocket.OPEN && tokenList.length > 0) {
            const req = {
                action: 1, // Subscribe
                params: { mode: 2, tokenList: tokenList }
            };
            angelWS.send(JSON.stringify(req));
            console.log(`Subscribed to ${tokenList.length} tokens for ${socket.id}`);
        }
    });

    socket.on('disconnect', () => {
        console.log('App Disconnected:', socket.id);
    });
});

function resubscribeAll() {
    // Reconnection ke baad logic (Optional: abhi ke liye skip kar sakte hain)
}

// Server Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    connectToAngel(); // Start connection loop
});