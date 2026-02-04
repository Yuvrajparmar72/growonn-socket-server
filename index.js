const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); // JSON data padhne ke liye

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- Memory Storage (Database ki jagah) ---
let angelCredentials = {
    feedToken: null,
    clientCode: null,
    apiKey: null
};

let angelWS = null;

// --- 1. Endpoint: App yaha Token bhejega ---
app.post('/update-token', (req, res) => {
    const { feedToken, clientCode, apiKey } = req.body;
    
    if (!feedToken || !clientCode || !apiKey) {
        return res.status(400).json({ error: "Missing details" });
    }

    // Save to Memory
    angelCredentials = { feedToken, clientCode, apiKey };
    console.log("✅ New Token Received from App!");

    // Purana connection todo aur naya banao
    if (angelWS) angelWS.terminate();
    connectToAngel();

    res.json({ success: true, message: "Token Updated & Stream Restarted" });
});

app.get('/', (req, res) => res.send("Trading Server is Running!"));

// --- 2. Angel One Connection Logic ---
function connectToAngel() {
    if (!angelCredentials.feedToken) {
        console.log("⚠️ Waiting for Token from App...");
        return;
    }

    const { feedToken, clientCode, apiKey } = angelCredentials;
    const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${clientCode}&feedToken=${feedToken}&apiKey=${apiKey}`;
    
    console.log("🔄 Connecting to Angel One...");
    angelWS = new WebSocket(wsUrl);

    angelWS.on('open', () => {
        console.log("🟢 Connected to Angel One WebSocket");
        // Yaha hum resubscribe logic daal sakte hain agar zarurat ho
    });

    angelWS.on('message', (data) => {
        if (data instanceof Buffer) {
            // Binary Parsing (Same as before)
            const parsed = parseBinary(data); 
            if (parsed) {
                // Seedha Socket.io room me bhej do
                io.to(`TOKEN:${parsed.token}`).emit('market-update', {
                    symbol_token: parsed.token,
                    ltp: parsed.ltp,
                    // ... baki fields
                });
            }
        }
    });

    angelWS.on('close', () => console.log("🔴 Angel Disconnected"));
    angelWS.on('error', (err) => console.error("Angel Error:", err.message));
}

// --- 3. Binary Parser (Chhota version) ---
function parseBinary(buffer) {
    try {
        const dv = new DataView(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        if (buffer.byteLength < 51) return null;
        
        // Token string nikalna
        let tokenStr = "";
        const tokenBytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset + 2, buffer.byteOffset + 27));
        for(let i=0; i<tokenBytes.length; i++) if(tokenBytes[i]!==0) tokenStr += String.fromCharCode(tokenBytes[i]);
        
        const ltp = dv.getInt32(43, true) / 100;
        return { token: tokenStr.trim(), ltp };
    } catch (e) { return null; }
}

// --- 4. Mobile App Users ---
io.on('connection', (socket) => {
    console.log('📱 App User Connected:', socket.id);
    
    socket.on('subscribe', (tokens) => {
        tokens.forEach(t => {
            socket.join(`TOKEN:${t.token}`);
            // Angel ko subscribe request bhejo (Logic same as previous)
            if(angelWS && angelWS.readyState === 1) {
                const req = {
                    action: 1, 
                    params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: [t.token] }] }
                };
                angelWS.send(JSON.stringify(req));
            }
        });
    });
});

server.listen(process.env.PORT || 3000, () => console.log("🚀 Server Ready"));
