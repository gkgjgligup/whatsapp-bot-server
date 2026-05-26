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

        // ১. শুরুতেই সমস্ত স্পেশাল ক্যারেক্টার, স্পেস এবং প্লাস (+) চিহ্ন মুছে শুধু সংখ্যা রাখা
        let cleaned = phone.replace(/[^0-9]/g, '');
        let phoneNumber = '';

        // ২. বুলেটপ্রুফ গ্লোবাল কান্ট্রি কোড ফিল্টারিং
        if (cleaned.startsWith('880') && cleaned.length === 13) {
            phoneNumber = cleaned; // অলরেডি সঠিক বাংলাদেশী ফরম্যাট
        } 
        else if (cleaned.startsWith('88') && cleaned.length === 12) {
            // যদি কেউ ভুল করে ৮৮১৭... দেয় (মাঝের ০ বাদ দেয়)
            phoneNumber = '880' + cleaned.substring(2);
        } 
        else if ((cleaned.startsWith('01') && cleaned.length === 11) || (cleaned.startsWith('1') && cleaned.length === 10)) {
            // বাংলাদেশ (BD): ০১৭... অথবা ১৭... উভয় ক্ষেত্রেই পারফেক্ট ৮৮০১৭... বানাবে
            let mainNumber = cleaned.startsWith('0') ? cleaned.substring(1) : cleaned;
            phoneNumber = '880' + mainNumber;
        } 
        else if (cleaned.length === 10 && (cleaned.startsWith('7') || cleaned.startsWith('8') || cleaned.startsWith('9') || cleaned.startsWith('6'))) {
            // ভারত (IN): ১০ ডিজিটের নাম্বার হলে শুরুতে ৯১ বসবে
            phoneNumber = '91' + cleaned;
        } 
        else if (cleaned.startsWith('91') && cleaned.length === 12) {
            phoneNumber = cleaned; // অলরেডি সঠিক ইন্ডিয়ান ফরম্যাট
        }
        else if ((cleaned.startsWith('05') && cleaned.length === 10) || (cleaned.startsWith('5') && cleaned.length === 9)) {
            // সৌদি আরব (SA): ০৫... অথবা ৫... থাকলে ৯৬৬৫... বানাবে
            let mainNumber = cleaned.startsWith('0') ? cleaned.substring(1) : cleaned;
            phoneNumber = '966' + mainNumber;
        } 
        else if (cleaned.startsWith('966') && cleaned.length === 12) {
            phoneNumber = cleaned; // অলরেডি সঠিক সৌদি ফরম্যাট
        }
        else if (cleaned.startsWith('01') && (cleaned.length === 10 || cleaned.length === 11)) {
            // মালয়েশিয়া (MY): ০১... দিয়ে শুরু হলে সামনের ০ কেটে ৬০ বসবে
            phoneNumber = '60' + cleaned.substring(1);
        } 
        else if (cleaned.startsWith('60') && (cleaned.length === 11 || cleaned.length === 12)) {
            phoneNumber = cleaned; // অলরেডি সঠিক মালয়েশিয়ান ফরম্যাট
        } 
        else {
            // যদি উপরের কোনো নিয়মে না পড়ে, তবে ইউজার যা দিয়েছে সেটাই সরাসরি পাঠানো হবে
            phoneNumber = cleaned;
        }

        console.log(`[WhatsApp API Request] Final Processed Number: "${phoneNumber}"`);

        // পুরানো কোনো সেশন ঝুলে থাকলে তা নিখুঁতভাবে রিমুভ করা
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
                // সেশন তৈরি হতে ৪.৫ সেকেন্ড সময় দেওয়া হলো
                setTimeout(async () => {
                    try {
                        console.log(`Sending pairing code request to WA Server for: ${phoneNumber}`);
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
                }, 4500);
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