
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cors = require('cors');
const mysql = require('mysql2/promise');
const fs = require('fs');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Socket.io Setup
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==========================================
// 🗄️ MySQL Database Connection (Admin Panel)
// ==========================================
// আপনার ডাটাবেসের আসল তথ্যগুলো এখানে বসাবেন
const dbConfig = {
    host: 'sql309.infinityfree.com',      // আপনার হোস্টিং ডাটাবেস হোস্ট
    user: 'if0_41896340',           // আপনার ডাটাবেস ইউজারনেম
    password: 'e5eOsjredKVrz',           // আপনার ডাটাবেস পাসওয়ার্ড
    database: 'if0_41896340_bdclub' // ডাটাবেসের নাম
};

// অ্যাডমিন প্যানেল থেকে পেন্ডিং নাম্বার এবং মেসেজ কালেক্ট করা
async function getAdminMessages() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT target_number, message FROM admin_messages WHERE status = "pending"');
        await connection.end();
        return rows;
    } catch (error) {
        console.log("⚠️ Database not connected. Using Demo Data for testing...");
        // ডাটাবেস কানেক্ট না থাকলে বা টেবিল না বানালে সার্ভার ক্র্যাশ করবে না, ডেমো ডাটা দিয়ে টেস্ট করবে
        return [
            { target_number: "8801700000001", message: "হ্যালো! এটি একটি অটোমেটিক টেস্ট মেসেজ।" },
            { target_number: "8801700000002", message: "হ্যালো! এটি একটি অটোমেটিক টেস্ট মেসেজ।" },
            { target_number: "8801700000003", message: "হ্যালো! এটি একটি অটোমেটিক টেস্ট মেসেজ।" }
        ];
    }
}

// Server Health Check Route
app.get('/', (req, res) => {
    res.send("✅ WhatsApp Auto SMS Server is Running Perfectly!");
});

// ==========================================
// 🚀 WhatsApp Live Connection Logic
// ==========================================
io.on('connection', (socket) => {
    console.log('🌐 A user connected to the website:', socket.id);

    socket.on('request_wa_code', async (data) => {
        const phoneNumber = data.phone; 
        const userId = data.user_id;

        console.log(`📱 Requesting Pairing Code for: ${phoneNumber}`);

        // সেশন সেভ করার ফোল্ডার তৈরি
        if (!fs.existsSync('./sessions')) {
            fs.mkdirSync('./sessions');
        }

        const { state, saveCreds } = await useMultiFileAuthState(`sessions/session_${phoneNumber}`);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"] // লিনাক্স ক্রোম ব্রাউজারের পরিচয় দিবে
        });

        sock.ev.on('creds.update', saveCreds);

        // ১. যদি লগইন না থাকে, ৮-ডিজিটের কোড তৈরি করবে
        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(phoneNumber);
                    socket.emit('wa_pairing_code', code);
                    console.log(`🔑 Code Generated for ${phoneNumber}: ${code}`);
                } catch (err) {
                    console.log("❌ Error generating code:", err.message);
                }
            }, 2500);
        }

        // ২. ইউজার যখন কোড বসিয়ে লগইন সফল করবে
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`🟢 WhatsApp Linked Successfully for: ${phoneNumber}`);
                socket.emit('wa_connected', { phone: phoneNumber });
                
                // ২ সেকেন্ড পর অটোমেটিক মেসেজ পাঠানো শুরু
                setTimeout(() => {
                    startAutoMessaging(sock, socket, phoneNumber);
                }, 2000);
            } 
            else if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log(`⚠️ Connection closed for ${phoneNumber}, reconnecting...`);
                } else {
                    console.log(`🔴 WhatsApp Logged Out for: ${phoneNumber}`);
                    fs.rmSync(`sessions/session_${phoneNumber}`, { recursive: true, force: true });
                }
            }
        });
    });
});

// ==========================================
// 📨 Auto Messaging Execution
// ==========================================
async function startAutoMessaging(sock, socket, phoneNumber) {
    console.log(`🚀 Starting Auto SMS for ${phoneNumber}...`);

    const messagesToSend = await getAdminMessages();
    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < messagesToSend.length; i++) {
        let targetNumber = messagesToSend[i].target_number;
        let msgContent = messagesToSend[i].message;
        let jid = targetNumber + "@s.whatsapp.net"; 
        
        try {
            await sock.sendMessage(jid, { text: msgContent });
            sentCount++;
            console.log(`✅ SMS Sent to: ${targetNumber}`);
        } catch (error) {
            failedCount++;
            console.log(`❌ Failed to send SMS to: ${targetNumber}`);
        }

        // ওয়েবসাইটে লাইভ প্রোগ্রেস ও ব্যালেন্স আপডেট পাঠানো (২.৬০ টাকা প্রতি SMS)
        let progress = ((i + 1) / messagesToSend.length) * 100;
        let earnedMoney = 2.60; 

        socket.emit('wa_execution_progress', { 
            progress: progress, 
            target_number: targetNumber,
            earned: earnedMoney 
        });

        // स्प্যামিং থেকে বাঁচতে ৫ থেকে ৮ সেকেন্ডের রেন্ডম বিরতি
        let randomDelay = Math.floor(Math.random() * (8000 - 5000 + 1)) + 5000;
        await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    // সব মেসেজ শেষ হলে ওয়েবসাইটে সিগন্যাল পাঠানো
    socket.emit('wa_execution_complete', { 
        sent: sentCount, 
        failed: failedCount,
        earned: 0 // Progress এ টাকা যোগ হয়ে গেছে, তাই এখানে ০
    });

    console.log(`🏁 Auto SMS Finished for ${phoneNumber}`);
}

// সার্ভার চালু করা
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 Node.js Server is running on port ${PORT}`);
});