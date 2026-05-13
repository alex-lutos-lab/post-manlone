const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

let db;
(async () => {
    db = await open({
        filename: './database.db',
        driver: sqlite3.Database
    });

    // Create the table if it doesn't exist
    console.log("Database is ready!");
    await db.exec(`
        CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            url TEXT,
            method TEXT,
            headers TEXT,
            payload TEXT,
            iterations INTEGER DEFAULT 1
        )
    `);
})();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const path = require('path');

app.use(cors());
app.use(express.json());

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/run-batch', async (req, res) => {
    // 1. Setup EventStream Headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendLog = (msg) => {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
    };

    // Prevent timeout for large batches
    req.socket.setTimeout(0);

    const { url, method, headers, payloads, iterations } = req.body;
    let parsedHeaders = {};
    let parsedPayloads = [];

    // 2. SMART PARSING (This replaces the old broken block)
    try {
        if (typeof headers === 'string' && headers.trim() !== "") {
            parsedHeaders = JSON.parse(headers);
        }

        if (typeof payloads === 'string' && payloads.trim() !== "") {
            const cleaned = payloads.trim();
            // UNIVERSAL LOGIC: 
            // If it starts with [, parse it as an array. 
            // Otherwise, parse it as an object and wrap it in [].
            if (cleaned.startsWith('[')) {
                parsedPayloads = JSON.parse(cleaned);
            } else {
                parsedPayloads = [JSON.parse(cleaned)];
            }
        } else if (typeof payloads === 'object' && payloads !== null) {
            // Safety check: if it's already an object (from req.body), wrap it
            parsedPayloads = Array.isArray(payloads) ? payloads : [payloads];
        }
    } catch (e) {
        sendLog({ message: `❌ JSON Syntax Error: ${e.message}`, type: "error" });
        return res.end();
    }

    sendLog({ message: "🚀 Connection Established. Starting Batch...", type: "success" });

    // 3. EXECUTION LOOP
    try {
        // This loop now safely uses parsedPayloads which is GUARANTEED to be an array
        for (let i = 0; i < (iterations || 1); i++) {
            sendLog({ message: `--- Iteration ${i + 1} ---`, type: "info" });
            
            res.write(': heartbeat\n\n'); 

            await Promise.all(parsedPayloads.map(async (data, index) => {
                try {
                    const startTime = Date.now();
                    const response = await axios({
                        url,
                        method: (method || 'POST').toUpperCase(),
                        headers: parsedHeaders,
                        data: data,
                        timeout: 15000 
                    });
                    const duration = Date.now() - startTime;

                    sendLog({ 
                        message: `[Req ${index + 1}] Success: ${response.status} (${duration}ms)`, 
                        type: "success",
                        body: response.data 
                    });
                } catch (error) {
                    sendLog({ 
                        message: `[Req ${index + 1}] Failed: ${error.message}`, 
                        type: "error",
                        body: error.response ? error.response.data : { error: error.message }
                    });
                }
            }));
        }
    } catch (error) {
        sendLog({ message: `Fatal Loop Error: ${error.message}`, type: "error" });
    }

    sendLog({ message: "✅ All requests completed.", type: "info" });
    res.end();
});

app.put('/api/collections/rename', (req, res) => {
    const { oldName, newName } = req.body;
    console.log("Request received for:", oldName, "to", newName);

    if (!oldName || !newName) {
        return res.status(400).json({ error: "Both oldName and newName are required" });
    }

    const sql = `UPDATE collections SET name = ? WHERE name = ?`;

    console.log(`Executing SQL: UPDATE collections SET name = ${newName} WHERE name = ${oldName}`);
    db.run(sql, [newName, oldName], function(err) {
        console.log("Inside db.run callback!");
        if (err) {
            console.error("DB Update Error:", err.message);
            return res.status(500).json({ error: "Database error occurred" });
        }
        res.json({ success: true, message: "Collection renamed" });
    });

    return res.json({ success: true, message: "Testing bypass" });

});

app.post('/api/save-collection', async (req, res) => {
    try {
        const { name, url, method, headers, payload, iterations } = req.body;
        
        // Ensure payload and headers are strings before saving to SQLite
        const headersStr = typeof headers === 'object' ? JSON.stringify(headers) : headers;
        const payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : payload;

        await db.run(
            `INSERT INTO collections (name, url, method, headers, payload, iterations) 
             VALUES (?, ?, ?, ?, ?, ?) 
             ON CONFLICT(name) DO UPDATE SET 
             url=excluded.url, 
             method=excluded.method, 
             headers=excluded.headers, 
             payload=excluded.payload,
             iterations=excluded.iterations`,
            [name, url, method, headersStr, payloadStr, iterations || 1]
        );

        console.log(`✅ Saved collection: ${name}`);
        res.json({ status: 'saved' });
    } catch (err) {
        console.error("❌ Save Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Add a route to Load all
app.get('/api/collections', async (req, res) => {
    const collections = await db.all('SELECT * FROM collections');
    res.json(collections);
});

app.get('/api/collections', (req, res) => {
    db.all("SELECT * FROM collections", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.delete('/api/delete-collection/:name', (req, res) => {
    const { name } = req.params;

    // Safety: Prevent deletion of the Default record if you choose to
    if (name === 'Default') {
        return res.status(400).json({ error: "Cannot delete the Default collection" });
    }

    const sql = `DELETE FROM collections WHERE name = ?`;

    db.run(sql, [name], function(err) {
        if (err) {
            console.error("❌ SQLite Delete Error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: "Collection not found" });
        }

        console.log(`🗑️ Deleted collection: ${name}`);
        res.json({ message: "Deleted successfully" });
    });
});

app.listen(5000, () => console.log('Backend engine running on port 5000'));