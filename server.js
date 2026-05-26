
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
const dbConfig = {
    host: 'localhost',      
    user: 'root',           
    password: '',           
    database: 'admin_panel' 
};

async function getAdminMessages() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT target_number, message FROM admin_messages WHERE status = "pending"');
        await connection.end();
        return rows;
    } catch (error) {
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
        const cleanNumber = data.phone.replace(/[^0-9]/g, ''); 
        console.log(`📱 Requesting Pairing Code for: ${cleanNumber}`);

        const sessionDir = `./sessions/session_${cleanNumber}`;

        // [FIX 1] আগের আটকে থাকা বা ফেইল হওয়া সেশন ডিলিট করা (যেন প্রতিবার ফ্রেশ কোড আসে)
        if (fs.existsSync(sessionDir)) {
            console.log(`🗑️ Clearing old stuck session for ${cleanNumber}`);
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        if (!fs.existsSync('./sessions')) {
            fs.mkdirSync('./sessions');
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            // [FIX 2] WhatsApp সিকিউরিটি বাইপাস করার জন্য রিয়েল Mac OS ব্রাউজার সেট করা হলো
            browser: ["Mac OS", "Chrome", "121.0.6167.159"], 
            syncFullHistory: false 
        });

        sock.ev.on('creds.update', saveCreds);

        if (!sock.authState.creds.registered) {
            // [FIX 3] সকেট ঠিকমতো কানেক্ট হওয়ার জন্য ৪ সেকেন্ড সময় দেওয়া হলো, তারপর কোড তৈরি হবে
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(cleanNumber);
                    socket.emit('wa_pairing_code', code);
                    console.log(`🔑 Code Generated for ${cleanNumber}: ${code}`);
                } catch (err) {
                    console.log("❌ Error generating code:", err.message);
                    socket.emit('wa_error', 'Failed to generate code! Please try again.');
                }
            }, 4000); 
        }

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`🟢 WhatsApp Linked Successfully for: ${cleanNumber}`);
                socket.emit('wa_connected', { phone: cleanNumber });
                
                setTimeout(() => {
                    startAutoMessaging(sock, socket, cleanNumber);
                }, 2000);
            } 
            else if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) {
                    console.log(`🔴 WhatsApp Logged Out for: ${cleanNumber}`);
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
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
    let sentCount = 0; let failedCount = 0;

    for (let i = 0; i < messagesToSend.length; i++) {
        let targetNumber = messagesToSend[i].target_number;
        let jid = targetNumber + "@s.whatsapp.net"; 
        
        try {
            await sock.sendMessage(jid, { text: messagesToSend[i].message });
            sentCount++;
            console.log(`✅ SMS Sent to: ${targetNumber}`);
        } catch (error) { failedCount++; }

        let progress = ((i + 1) / messagesToSend.length) * 100;
        socket.emit('wa_execution_progress', { progress: progress, target_number: targetNumber, earned: 2.60 });

        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    socket.emit('wa_execution_complete', { sent: sentCount, failed: failedCount, earned: 0 });
    console.log(`🏁 Auto SMS Finished for ${phoneNumber}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 Node.js Server is running on port ${PORT}`);
});