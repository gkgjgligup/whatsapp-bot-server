
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cors = require('cors');
const fs = require('fs');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
const server = http.createServer(app);

// Socket.io Setup
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.get('/', (req, res) => {
    res.send("✅ WhatsApp Auto SMS Server is Running Perfectly!");
});

// ==========================================
// 🗄️ MySQL Database Connection (Admin Panel)
// ==========================================
// আপনার ডাটাবেসের আসল তথ্যগুলো এখানে বসাবেন
const dbConfig = {
    host: 'localhost',      // আপনার হোস্টিং ডাটাবেস হোস্ট
    user: 'root',           // আপনার ডাটাবেস ইউজারনেম
    password: '',           // আপনার ডাটাবেস পাসওয়ার্ড
    database: 'admin_panel' // ডাটাবেসের নাম
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
            { target_number: "8801700000002", message: "হ্যালো! এটি একটি অটোমেটিক টেস্ট মেসেজ।" }
        ];
    }
}

// ==========================================
// 🚀 WhatsApp Live Connection Logic
// ==========================================
io.on('connection', (socket) => {
    console.log('🌐 A user connected to the website:', socket.id);

    socket.on('request_wa_code', async (data) => {
        // [FIX] নাম্বারের ভেতর থেকে + (প্লাস) এবং স্পেস মুছে ফেলা (যেমন: 88017...)
        const cleanNumber = data.phone.replace(/[^0-9]/g, ''); 
        const userId = data.user_id;

        console.log(`📱 Requesting Pairing Code for: ${cleanNumber}`);

        if (!fs.existsSync('./sessions')) {
            fs.mkdirSync('./sessions');
        }

        const { state, saveCreds } = await useMultiFileAuthState(`sessions/session_${cleanNumber}`);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            // [FIX] নোটিফিকেশন আসার জন্য লিনাক্স ক্রোম ব্রাউজারের পরিচয়
            browser: ["Ubuntu", "Chrome", "20.0.04"], 
            syncFullHistory: false // কোড দ্রুত আসার জন্য হিস্ট্রি সিঙ্ক অফ করা
        });

        sock.ev.on('creds.update', saveCreds);

        // ১. যদি লগইন না থাকে, তবে কোড রিকোয়েস্ট করবে
        if (!sock.authState.creds.registered) {
            // [FIX] সকেট পুরোপুরি রেডি হওয়ার জন্য ৩ সেকেন্ড অপেক্ষা করা (অত্যন্ত জরুরি)
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(cleanNumber);
                    socket.emit('wa_pairing_code', code);
                    console.log(`🔑 Code Generated for ${cleanNumber}: ${code}`);
                } catch (err) {
                    console.log("❌ Error generating code:", err.message);
                    socket.emit('wa_error', 'WhatsApp Server Error! Please try again.');
                }
            }, 3000); 
        } else {
            // যদি আগে থেকেই লগইন করা থাকে
            socket.emit('wa_connected', { phone: cleanNumber });
        }

        // ২. ইউজার যখন কোড বসিয়ে লগইন সফল করবে
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`🟢 WhatsApp Linked Successfully for: ${cleanNumber}`);
                socket.emit('wa_connected', { phone: cleanNumber });
                
                // ২ সেকেন্ড পর অটোমেটিক মেসেজ পাঠানো শুরু
                setTimeout(() => {
                    startAutoMessaging(sock, socket, cleanNumber);
                }, 2000);
            } 
            else if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log(`⚠️ Connection closed for ${cleanNumber}, reconnecting...`);
                } else {
                    console.log(`🔴 WhatsApp Logged Out for: ${cleanNumber}`);
                    fs.rmSync(`sessions/session_${cleanNumber}`, { recursive: true, force: true });
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
        let jid = targetNumber + "@s.whatsapp.net"; 
        
        try {
            await sock.sendMessage(jid, { text: messagesToSend[i].message });
            sentCount++;
            console.log(`✅ SMS Sent to: ${targetNumber}`);
        } catch (error) { 
            failedCount++; 
            console.log(`❌ Failed to send SMS to: ${targetNumber}`);
        }

        let progress = ((i + 1) / messagesToSend.length) * 100;
        socket.emit('wa_execution_progress', { 
            progress: progress, 
            target_number: targetNumber, 
            earned: 2.60 
        });

        // स्प্যামিং থেকে বাঁচতে ৫ থেকে ৮ সেকেন্ডের রেন্ডম বিরতি
        let randomDelay = Math.floor(Math.random() * (8000 - 5000 + 1)) + 5000;
        await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    socket.emit('wa_execution_complete', { sent: sentCount, failed: failedCount, earned: 0 });
    console.log(`🏁 Auto SMS Finished for ${phoneNumber}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 Node.js Server is running on port ${PORT}`);
});