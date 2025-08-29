const axios = require('axios');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware di sicurezza e parsing
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

class EcwidSyncManager {
    constructor(config) {
        this.config = {
            storeId: config.storeId,
            apiToken: config.apiToken,
            baseUrl: `https://app.ecwid.com/api/v3/${config.storeId}`,
            maxRetries: 5,
            retryDelay: 1000,
            batchSize: 25,
            requestDelay: 250,
            logFile: 'ecwid-sync.log',
            ...config
        };
        
        this.stats = {
            success: 0,
            created: 0,
            updated: 0,
            ignored: 0,
            error: 0,
            errorSKUs: [],
            startTime: new Date().toISOString()
        };
        
        this.lastProcessedIndex = 0;
        this.logs = [];
    }

    // Logging avanzato
    async log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            stats: { ...this.stats }
        };
        
        this.logs.push(logEntry);
        console.log(`[${timestamp}] [${level}] ${message}`);
        
        // Mantieni solo gli ultimi 1000 log in memoria
        if (this.logs.length > 1000) {
            this.logs = this.logs.slice(-1000);
        }
    }

    // Test connessione API
    async testConnection() {
        try {
            await this.log('Testing API connection...');
            const response = await axios.get(`${this.config.baseUrl}/profile`, {
                headers: {
                    'Authorization': `Bearer ${this.config.apiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
            
            await this.log(`✓ Connected to store: ${response.data.generalInfo?.storeUrl || 'Unknown'}`);
            return { success: true, store: response.data.generalInfo };
        } catch (error) {
            await this.log(`✗ API connection failed: ${error.message}`, 'ERROR');
            return { success: false, error: error.message };
        }
    }

    // Utility sleep
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// === API ENDPOINTS ===

// Health check per Railway
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'Ecwid Sync Server',
        version: '1.0.0'
    });
});

// Status generale del servizio
app.get('/api/status', (req, res) => {
    res.json({
        service: 'Ecwid Sync Server',
        status: 'running',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        endpoints: {
            sync: 'POST /api/sync',
            test: 'POST /api/test-connection',
            status: 'GET /api/status',
            health: 'GET /health'
        }
    });
});

// Test connessione Ecwid
app.post('/api/test-connection', async (req, res) => {
    try {
        const { storeId, apiToken } = req.body;
        
        if (!storeId || !apiToken) {
            return res.status(400).json({
                error: 'Missing required fields: storeId, apiToken'
            });
        }

        const syncManager = new EcwidSyncManager({ storeId, apiToken });
        const result = await syncManager.testConnection();
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Connection successful',
                store: result.store,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error,
                timestamp: new Date().toISOString()
            });
        }

    } catch (error) {
        console.error('Connection test error:', error);
        res.status(500).json({
            success: false,
            error: 'Connection test failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.originalUrl,
        available_endpoints: [
            'GET /health',
            'GET /api/status', 
            'POST /api/test-connection'
        ],
        timestamp: new Date().toISOString()
    });
});

// Avvio server - CRITICO per Railway: bind su 0.0.0.0
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 Ecwid Sync Server Successfully Started!');
    console.log(`📊 Server running on port: ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📡 Status: http://localhost:${PORT}/api/status`);
    console.log(`⚡ Ready for product synchronization!\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('📴 Server shutting down gracefully...');
    server.close(() => {
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('📴 Server shutting down gracefully...');
    server.close(() => {
        process.exit(0);
    });
});

module.exports = app;
