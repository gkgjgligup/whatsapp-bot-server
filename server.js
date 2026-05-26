const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const activeWaSockets = new Map();

// নাম্বারের জিরো এবং কান্ট্রি কোড ফিক্স করার গ্লোবাল ফাংশন
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/[^0-9]/g, '');
    
    // বাংলাদেশ (BD)
    if (cleaned.startsWith('880') && cleaned.length === 13) return cleaned;
    if (cleaned.startsWith('88') && cleaned.length === 12) return '880' + cleaned.substring(2);
    if (cleaned.startsWith('01') && cleaned.length === 11) return '880' + cleaned.substring(1);
    if (cleaned.length === 10 && /^[1-9]/.test(cleaned)) return '880' + cleaned;
    
    // ভারত (IN)
    if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) return '91' + cleaned;
    if (cleaned.startsWith('91') && cleaned.length === 12) return cleaned;
    
    // সৌদি আরব (SA)
    if (cleaned.startsWith('05') && cleaned.length === 10) return '966' + cleaned.substring(1);
    if (cleaned.length === 9 && cleaned.startsWith('5')) return '966' + cleaned;
    
    // মালয়েশিয়া (MY)
    if (cleaned.startsWith('01') && (cleaned.length === 10 || cleaned.length === 11)) return '60' + cleaned.substring(1);
    
    return cleaned;
}

io.on('connection', (socket) => {
    console.log(`Client Connected: ${socket.id}`);

    socket.on('request_wa_code', async (data) => {
        const { phone, user_id } = data;
        
        if (!phone || !user_id) {
            socket.emit('wa_error', 'Invalid Phone Number or User ID!');
            return;
        }

        const phoneNumber = formatPhoneNumber(phone);
        console.log(`[WhatsApp System] Processing Number: ${phoneNumber} for User: ${user_id}`);

        // আগে থেকে সকেট সেশন রান থাকলে তা রিমুভ করা
        if (activeWaSockets.has(user_id)) {
            try {
                const oldSock = activeWaSockets.get(user_id);
                oldSock.ev.removeAllListeners();
                oldSock.end();
            } catch (e) {}
            activeWaSockets.delete(user_id);
        }

        async function startWhatsAppSession() {
            try {
                const sessionFolder = `session_${user_id}`;
                const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

                const sock = makeWASocket({
                    auth: state,
                    logger: pino({ level: 'silent' }), 
                    printQRInTerminal: false,
                    browser: ["Ubuntu", "Chrome", "20.0.04"] 
                });

                activeWaSockets.set(user_id, sock);
                sock.ev.on('creds.update', saveCreds);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect } = update;
                    
                    if (connection === 'open') {
                        console.log(`🟢 WhatsApp Auto-Logged In / Connected for User: ${user_id}`);
                        socket.emit('wa_connected', { phone, user_id });
                    }

                    if (connection === 'close') {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                        
                        console.log(`🔴 Connection closed. Reconnecting: ${shouldReconnect}`);
                        activeWaSockets.delete(user_id);

                        if (statusCode === DisconnectReason.loggedOut) {
                            console.log(`User ${user_id} logged out. Clearing session folder.`);
                            socket.emit('wa_disconnected_by_user', 'Logged out from phone');
                            try {
                                fs.rmSync(sessionFolder, { recursive: true, force: true });
                            } catch (err) {}
                        } else if (shouldReconnect) {
                            // অটো রিকানেক্ট মেকানিজম (সার্ভার ডাউন হলে বা নেট চলে গেলে)
                            setTimeout(() => startWhatsAppSession(), 5000);
                        }
                    }
                });

                // --- অটো লগইন এবং কোড জেনারেশন লজিক ---
                if (!sock.authState.creds.registered) {
                    // যদি আগে লগইন করা না থাকে, তবেই কোড চাইবে
                    setTimeout(async () => {
                        try {
                            console.log(`🤖 Requesting Code from WA Server for: ${phoneNumber}`);
                            let code = await sock.requestPairingCode(phoneNumber);
                            
                            if (code && !code.includes('-')) {
                                code = `${code.slice(0, 4)}-${code.slice(4)}`;
                            }
                            
                            console.log(`Generated Code: ${code}`);
                            socket.emit('wa_pairing_code', code);
                        } catch (err) {
                            console.error("WA Server Error:", err.message);
                            socket.emit('wa_error', `WhatsApp server is rate-limiting this number. Please wait 30 minutes or try another number.`);
                        }
                    }, 5000);
                } else {
                    // যদি অলরেডি লগইন সেশন ডাটা ফোল্ডারে থাকে, সরাসরি কানেক্টেড দেখাবে (No Code Needed!)
                    console.log(`🎯 Active session found for User ${user_id}. Auto-logging in...`);
                    socket.emit('wa_connected', { phone, user_id });
                }

            } catch (error) {
                console.error("Process Error:", error);
                socket.emit('wa_error', 'Internal Server Error.');
            }
        }

        // সেশন স্টার্ট করা
        startWhatsAppSession();
    });

    socket.on('disconnect', () => {
        console.log(`Client Socket Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Real WA Server running on port ${PORT}`));