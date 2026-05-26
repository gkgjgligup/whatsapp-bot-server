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

// একটি গ্লোবাল ম্যাপ ট্র্যাকিং করার জন্য (এক ইউজার যেন একাধিক সেশন চালু করতে না পারে)
const activeWaSockets = new Map();

io.on('connection', (socket) => {
    console.log(`Client Connected: ${socket.id}`);

    // হোয়াটসঅ্যাপ কানেকশন হ্যান্ডলার
    socket.on('request_wa_code', async (data) => {
        const { phone, user_id } = data;
        
        if (!phone || !user_id) {
            socket.emit('wa_error', 'Invalid Phone Number or User ID!');
            return;
        }

        // সমস্ত স্পেশাল ক্যারেক্টার ও প্লাস (+) চিহ্ন রিমুভ করে শুধু সংখ্যা রাখা
        let phoneNumber = phone.replace(/[^0-9]/g, '');

        // --- মাল্টিপল কান্ট্রি কোড ফরম্যাটিং ফিক্স ---
        
        // ১. বাংলাদেশ (BD): ০ দিয়ে শুরু হলে ৮৮ যুক্ত হবে
        if (phoneNumber.startsWith('0') && !phoneNumber.startsWith('88')) {
            phoneNumber = '88' + phoneNumber;
        }
        // ২. ভারত (IN): যদি কান্ট্রি কোড ছাড়া ১০ ডিজিটের নাম্বার দেয় এবং ৯ বা ৮ বা ৭ বা ৬ দিয়ে শুরু হয়
        else if (phoneNumber.length === 10 && /^[6-9]/.test(phoneNumber)) {
            phoneNumber = '91' + phoneNumber;
        }
        // ৩. সৌদি আরব (SA): যদি কান্ট্রি কোড ছাড়া ৫ দিয়ে শুরু হওয়া ৯ ডিজিটের নাম্বার দেয়
        else if (phoneNumber.length === 9 && phoneNumber.startsWith('5')) {
            phoneNumber = '966' + phoneNumber;
        }
        // ৪. মালয়েশিয়া (MY): যদি কান্ট্রি কোড ছাড়া ১ বা ০ দিয়ে শুরু হওয়া নাম্বার দেয় (সাধারণত ৯ থেকে ১১ ডিজিট)
        else if ((phoneNumber.startsWith('1') || phoneNumber.startsWith('01')) && phoneNumber.length <= 11 && !phoneNumber.startsWith('60')) {
            if (phoneNumber.startsWith('0')) {
                phoneNumber = '60' + phoneNumber.substring(1); // ০ বাদ দিয়ে ৬০ বসানো
            } else {
                phoneNumber = '60' + phoneNumber;
            }
        }

        // [ফিক্স ১]: এই ইউজার যদি আগে থেকেই রিকোয়েস্ট করে থাকে, তবে আগের সেশনটি বন্ধ করে দেওয়া হবে
        if (activeWaSockets.has(user_id)) {
            console.log(`Cleaning old session for User: ${user_id}`);
            try {
                const oldSock = activeWaSockets.get(user_id);
                oldSock.ev.removeAllListeners(); // সব লিসেনার রিমুভ
                oldSock.end(); // সেশন ক্লোজ
            } catch (e) {
                console.log("Error closing old socket:", e.message);
            }
            activeWaSockets.delete(user_id);
        }

        try {
            // হোয়াটসঅ্যাপ সেশন ডাটা সেভ করার জন্য
            const { state, saveCreds } = await useMultiFileAuthState(`session_${user_id}`);

            const sock = makeWASocket({
                auth: state,
                logger: pino({ level: 'silent' }), 
                printQRInTerminal: false,
                browser: ["Ubuntu", "Chrome", "20.0.04"] 
            });

            // সেশনটি ট্র্যাকিং ম্যাপে সেভ রাখা হচ্ছে
            activeWaSockets.set(user_id, sock);

            // সেশন ক্রেডেনশিয়াল আপডেট হলে সেভ করার জন্য
            sock.ev.on('creds.update', saveCreds);

            // হোয়াটসঅ্যাপের কানেকশন স্টেট মনিটর করা
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
                    
                    // সেশন ম্যাপ থেকে মুছে দেওয়া
                    activeWaSockets.delete(user_id);

                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log(`User ${user_id} logged out from Phone.`);
                        socket.emit('wa_disconnected_by_user', 'Logged out from phone');
                    }
                }
            });

            // যদি আগে থেকে লগইন না থাকে, তবেই কেবল পেয়ারিং কোড রিকোয়েস্ট করবে
            if (!sock.authState.creds.registered) {
                setTimeout(async () => {
                    try {
                        // হোয়াটসঅ্যাপ সার্ভার থেকে আসল পেয়ারিং কোড জেনারেট
                        let code = await sock.requestPairingCode(phoneNumber);
                        
                        // [ফিক্স ২]: কোড ফরম্যাটিং সেফগার্ড (ড্যাশ অলরেডি থাকলে নতুন করে ড্যাশ বসাবে না)
                        if (code && !code.includes('-')) {
                            code = `${code.slice(0, 4)}-${code.slice(4)}`;
                        }
                        
                        console.log(`Generated Pairing Code for ${user_id}: ${code}`);
                        socket.emit('wa_pairing_code', code);
                    } catch (err) {
                        console.error("Pairing Code Error for:", user_id, err.message);
                        socket.emit('wa_error', 'Failed to generate code. Please refresh and try again.');
                    }
                }, 3000);
            } else {
                // যদি অলরেডি লগইন থাকে, সরাসরি সাকসেস পাঠানো
                socket.emit('wa_connected', { phone, user_id });
            }

        } catch (error) {
            console.error("Main Process Error:", error);
            socket.emit('wa_error', 'Server Error occurred.');
        }
    });

    // ক্লায়েন্ট সকেট ডিসকানেক্ট হয়ে গেলে ট্র্যাকিং ফিক্স
    socket.on('disconnect', () => {
        console.log(`Client Socket Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Real WA Server running on port ${PORT}`));