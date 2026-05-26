const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const activeWaSockets = new Map();

io.on('connection', (socket) => {
    console.log(`Client Connected: ${socket.id}`);

    socket.on('request_wa_code', async (data) => {
        const { phone, user_id } = data;
        
        if (!phone || !user_id) {
            socket.emit('wa_error', 'Invalid Phone Number or User ID!');
            return;
        }

        // শুধু সংখ্যাগুলো আলাদা করা
        let phoneNumber = phone.replace(/[^0-9]/g, '');

        // --- ১০০% নিখুঁত কান্ট্রি কোড ফরম্যাটিং (8801xxx) ---
        if (phoneNumber.startsWith('880') && phoneNumber.length === 13) {
            // অলরেডি পারফেক্ট ফরম্যাটে আছে
        }
        else if (phoneNumber.startsWith('88') && !phoneNumber.startsWith('880') && phoneNumber.length === 12) {
            phoneNumber = '880' + phoneNumber.substring(2);
        }
        else if (phoneNumber.startsWith('0') && phoneNumber.length === 11) {
            phoneNumber = '880' + phoneNumber.substring(1); // শুরুর ০ বাদ দিয়ে ৮৮০ বসানো হলো
        } 
        else if (phoneNumber.length === 10 && /^[1-9]/.test(phoneNumber)) {
            phoneNumber = '880' + phoneNumber; // ১৭... থাকলে শুরুতে ৮৮০ বসানো হলো
        }
        
        // ২. ভারত (IN)
        else if (phoneNumber.length === 10 && /^[6-9]/.test(phoneNumber)) {
            phoneNumber = '91' + phoneNumber;
        }
        
        // ৩. সৌদি আরব (SA)
        else if (phoneNumber.startsWith('05') && phoneNumber.length === 10) {
            phoneNumber = '966' + phoneNumber.substring(1);
        } else if (phoneNumber.length === 9 && phoneNumber.startsWith('5')) {
            phoneNumber = '966' + phoneNumber;
        }
        
        // ৪. মালয়েশিয়া (MY)
        else if (phoneNumber.startsWith('01') && phoneNumber.length >= 10 && phoneNumber.length <= 11) {
            phoneNumber = '60' + phoneNumber.substring(1);
        } else if (phoneNumber.startsWith('1') && phoneNumber.length === 9) {
            phoneNumber = '60' + phoneNumber;
        }

        console.log(`[WhatsApp Request] Pure Phone Number: ${phoneNumber}`);

        if (activeWaSockets.has(user_id)) {
            console.log(`Cleaning old session for User: ${user_id}`);
            try {
                const oldSock = activeWaSockets.get(user_id);
                oldSock.ev.removeAllListeners();
                oldSock.end();
            } catch (e) {
                console.log("Error closing old socket:", e.message);
            }
            activeWaSockets.delete(user_id);
        }

        try {
            const { state, saveCreds } = await useMultiFileAuthState(`session_${user_id}`);

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
                    console.log(`WhatsApp Connected successfully for User: ${user_id}`);
                    socket.emit('wa_connected', { phone, user_id });
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    console.log(`Connection closed for ${user_id}. Reconnecting: ${shouldReconnect}`);
                    
                    activeWaSockets.delete(user_id);

                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log(`User ${user_id} logged out from Phone.`);
                        socket.emit('wa_disconnected_by_user', 'Logged out from phone');
                    }
                }
            });

            if (!sock.authState.creds.registered) {
                setTimeout(async () => {
                    try {
                        console.log(`Sending pairing code request to WA for: ${phoneNumber}`);
                        let code = await sock.requestPairingCode(phoneNumber);
                        
                        if (code && !code.includes('-')) {
                            code = `${code.slice(0, 4)}-${code.slice(4)}`;
                        }
                        
                        console.log(`Generated Pairing Code for ${user_id}: ${code}`);
                        socket.emit('wa_pairing_code', code);
                    } catch (err) {
                        console.error("Pairing Code Error for:", user_id, err.message);
                        socket.emit('wa_error', `Failed to generate code. Error: ${err.message}`);
                    }
                }, 4000);
            } else {
                socket.emit('wa_connected', { phone, user_id });
            }

        } catch (error) {
            console.error("Main Process Error:", error);
            socket.emit('wa_error', 'Server Error occurred.');
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client Socket Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Real WA Server running on port ${PORT}`));