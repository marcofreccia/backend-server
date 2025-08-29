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

    // Retry con backoff esponenziale
    async withRetry(operation, context = '') {
        let lastError;
        
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                const result = await operation();
                
                if (attempt > 1) {
                    await this.log(`✓ ${context} succeeded on attempt ${attempt}`);
                }
                
                return result;
            } catch (error) {
                lastError = error;
                
                // Non fare retry su errori definitivi
                if (error.response?.status === 404 || 
                    error.response?.status === 401 || 
                    error.response?.status === 403) {
                    throw error;
                }
                
                const delay = Math.min(
                    this.config.retryDelay * Math.pow(2, attempt - 1),
                    30000 // Max 30 secondi
                );
                
                await this.log(
                    `⚠ ${context} failed (attempt ${attempt}/${this.config.maxRetries}): ${error.message}. Retrying in ${delay}ms...`, 
                    'WARN'
                );
                
                if (attempt < this.config.maxRetries) {
                    await this.sleep(delay);
                }
            }
        }
        
        throw lastError;
    }

    // Request API con gestione errori avanzata
    async makeRequest(method, endpoint, data = null, headers = {}) {
        const url = `${this.config.baseUrl}${endpoint}`;
        
        const config = {
            method,
            url,
            headers: {
                'Authorization': `Bearer ${this.config.apiToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'MSY-Ecwid-Sync/1.0',
                ...headers
            },
            timeout: 60000,
            validateStatus: (status) => status < 500
        };
        
        if (data) {
            config.data = data;
        }
        
        const response = await axios(config);
        
        // Gestione risposte HTML invece di JSON
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            throw new Error(
                `Server returned HTML instead of JSON. Status: ${response.status}, URL: ${url}`
            );
        }
        
        // Validazione JSON response
        if (typeof response.data !== 'object') {
            throw new Error(`Invalid JSON response from ${url}`);
        }
        
        // Gestione errori HTTP 4xx
        if (response.status >= 400) {
            const errorMsg = response.data?.errorMessage || 
                            response.data?.message || 
                            `HTTP ${response.status}`;
            throw new Error(errorMsg);
        }
        
        return response.data;
    }

    // Test connessione API
    async testConnection() {
        try {
            await this.log('Testing API connection...');
            const profile = await this.makeRequest('GET', '/profile');
            await this.log(`✓ Connected to store: ${profile.generalInfo?.storeUrl || 'Unknown'}`);
            return { success: true, store: profile.generalInfo };
        } catch (error) {
            await this.log(`✗ API connection failed: ${error.message}`, 'ERROR');
            return { success: false, error: error.message };
        }
    }

    // Ricerca prodotto esistente
    async searchProduct(sku) {
        return await this.withRetry(async () => {
            const data = await this.makeRequest('GET', `/products?sku=${encodeURIComponent(sku)}&limit=1`);
            return data.items?.[0] || null;
        }, `Search product ${sku}`);
    }

    // Validazione e processamento URL immagini
    async processImageUrl(imageUrl, productSku) {
        if (!imageUrl || typeof imageUrl !== 'string') {
            return null;
        }
        
        // Validazione formato URL
        try {
            new URL(imageUrl);
        } catch {
            await this.log(`Invalid image URL format for ${productSku}: ${imageUrl}`, 'WARN');
            return null;
        }
        
        // Test accessibilità immagine
        try {
            const response = await axios.head(imageUrl, { 
                timeout: 10000,
                maxRedirects: 3
            });
            
            const contentType = response.headers['content-type'];
            if (!contentType?.startsWith('image/')) {
                await this.log(`URL is not an image for ${productSku}: ${imageUrl} (${contentType})`, 'WARN');
                return null;
            }
            
            const contentLength = parseInt(response.headers['content-length'] || '0');
            if (contentLength > 20 * 1024 * 1024) { // Max 20MB
                await this.log(`Image too large for ${productSku}: ${imageUrl} (${contentLength} bytes)`, 'WARN');
                return null;
            }
            
            return imageUrl;
        } catch (error) {
            await this.log(`Image URL not accessible for ${productSku}: ${imageUrl} - ${error.message}`, 'WARN');
            return null;
        }
    }

    // Upload immagine prodotto
    async uploadProductImage(productId, imageUrl, isMain = false, productSku = '') {
        if (!imageUrl) return null;
        
        const validatedUrl = await this.processImageUrl(imageUrl, productSku);
        if (!validatedUrl) return null;
        
        return await this.withRetry(async () => {
            const endpoint = isMain 
                ? `/products/${productId}/image`
                : `/products/${productId}/gallery`;
            
            const imageData = { externalUrl: validatedUrl };
            
            const result = await this.makeRequest('POST', endpoint, imageData);
            await this.log(`✓ ${isMain ? 'Main' : 'Gallery'} image uploaded for ${productSku}`);
            return result;
        }, `Upload ${isMain ? 'main' : 'gallery'} image for product ${productId}`);
    }

    // Creazione/aggiornamento prodotto
    async upsertProduct(productData) {
        const sku = productData.sku;
        let existingProduct = null;
        let isUpdate = false;
        
        try {
            // Ricerca prodotto esistente
            existingProduct = await this.searchProduct(sku);
            isUpdate = !!existingProduct;
            
            // Preparazione dati prodotto
            const productPayload = {
                name: productData.name || 'Untitled Product',
                sku: sku,
                price: parseFloat(productData.price) || 0,
                enabled: productData.enabled !== false,
                description: productData.description || '',
                weight: parseFloat(productData.weight) || 0,
                quantity: parseInt(productData.quantity) || 0,
                categoryIds: productData.categoryIds || [],
                attributes: productData.attributes || [],
                ...productData
            };
            
            // Estrazione URLs immagini
            const mainImageUrl = productPayload.mainImageUrl || productPayload.defaultDisplayedPriceFormatted;
            const galleryImages = productPayload.galleryImages || [];
            
            // Rimozione campi immagine dal payload principale
            delete productPayload.mainImageUrl;
            delete productPayload.defaultDisplayedPriceFormatted;
            delete productPayload.galleryImages;
            
            let result;
            
            if (isUpdate) {
                // Aggiornamento prodotto esistente
                result = await this.withRetry(async () => {
                    return await this.makeRequest('PUT', `/products/${existingProduct.id}`, productPayload);
                }, `Update product ${sku}`);
                
                this.stats.updated++;
            } else {
                // Creazione nuovo prodotto
                result = await this.withRetry(async () => {
                    return await this.makeRequest('POST', '/products', productPayload);
                }, `Create product ${sku}`);
                
                this.stats.created++;
            }
            
            const productId = result.id || existingProduct?.id;
            
            // Gestione immagini con tolleranza agli errori
            if (productId) {
                // Upload immagine principale
                if (mainImageUrl) {
                    try {
                        await this.uploadProductImage(productId, mainImageUrl, true, sku);
                    } catch (error) {
                        await this.log(`⚠ Failed to upload main image for ${sku}: ${error.message}`, 'WARN');
                    }
                }
                
                // Upload immagini gallery
                for (let i = 0; i < Math.min(galleryImages.length, 10); i++) {
                    try {
                        await this.uploadProductImage(productId, galleryImages[i], false, sku);
                        await this.sleep(200); // Pausa tra upload immagini
                    } catch (error) {
                        await this.log(`⚠ Failed to upload gallery image ${i+1} for ${sku}: ${error.message}`, 'WARN');
                    }
                }
            }
            
            this.stats.success++;
            await this.log(`✓ ${isUpdate ? 'Updated' : 'Created'} product: ${sku}`);
            
            return {
                success: true,
                action: isUpdate ? 'updated' : 'created',
                productId,
                sku
            };
            
        } catch (error) {
            this.stats.error++;
            this.stats.errorSKUs.push({
                sku: sku,
                step: existingProduct ? 'upsert' : 'search',
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            await this.log(`✗ Failed to process ${sku}: ${error.message}`, 'ERROR');
            return {
                success: false,
                error: error.message,
                sku
            };
        }
    }

    // Sincronizzazione prodotti in batch
    async syncProducts(products, onProgress = null) {
        if (!Array.isArray(products) || products.length === 0) {
            throw new Error('No products provided for sync');
        }
        
        // Test connessione iniziale
        const connectionTest = await this.testConnection();
        if (!connectionTest.success) {
            throw new Error(`Cannot establish API connection: ${connectionTest.error}`);
        }
        
        await this.log(`Starting sync of ${products.length} products in batches of ${this.config.batchSize}`);
        
        const startIndex = this.lastProcessedIndex;
        const totalBatches = Math.ceil((products.length - startIndex) / this.config.batchSize);
        const results = [];
        
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchStart = startIndex + (batchIndex * this.config.batchSize);
            const batchEnd = Math.min(batchStart + this.config.batchSize, products.length);
            const batch = products.slice(batchStart, batchEnd);
            
            await this.log(`Processing batch ${batchIndex + 1}/${totalBatches} (products ${batchStart + 1}-${batchEnd})`);
            
            // Processamento batch con gestione errori individuali
            for (const product of batch) {
                const result = await this.upsertProduct(product);
                results.push(result);
                this.lastProcessedIndex++;
                
                // Callback progresso opzionale
                if (onProgress) {
                    onProgress({
                        processed: this.lastProcessedIndex,
                        total: products.length,
                        current: product.sku,
                        stats: { ...this.stats }
                    });
                }
                
                // Rate limiting
                await this.sleep(this.config.requestDelay);
            }
            
            // Pausa tra batch
            if (batchIndex < totalBatches - 1) {
                await this.log(`Batch ${batchIndex + 1} completed. Waiting before next batch...`);
                await this.sleep(2000);
            }
        }
        
        const finalReport = await this.generateReport();
        return {
            success: true,
            summary: finalReport.summary,
            results,
            errors: this.stats.errorSKUs,
            logs: this.logs
        };
    }

    // Generazione report finale
    async generateReport() {
        const endTime = new Date().toISOString();
        const duration = Date.now() - Date.parse(this.stats.startTime);
        
        const report = {
            summary: {
                success: this.stats.success,
                created: this.stats.created,
                updated: this.stats.updated,
                ignored: this.stats.ignored,
                error: this.stats.error,
                total_processed: this.stats.success + this.stats.error,
                duration_ms: duration,
                start_time: this.stats.startTime,
                end_time: endTime
            },
            errors: this.stats.errorSKUs,
            logs: this.logs.slice(-50) // Ultimi 50 log
        };
        
        await this.log(`\n=== SYNC COMPLETED ===`);
        await this.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
        await this.log(`Total Processed: ${report.summary.total_processed}`);
        await this.log(`Successful: ${report.summary.success} (Created: ${report.summary.created}, Updated: ${report.summary.updated})`);
        await this.log(`Errors: ${report.summary.error}`);
        
        return report;
    }

    // Utility sleep
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Get current status
    getStatus() {
        return {
            stats: { ...this.stats },
            lastProcessedIndex: this.lastProcessedIndex,
            recentLogs: this.logs.slice(-10)
        };
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

// Sincronizzazione principale
app.post('/api/sync', async (req, res) => {
    try {
        const { storeId, apiToken, products, options = {} } = req.body;
        
        if (!storeId || !apiToken || !products) {
            return res.status(400).json({
                error: 'Missing required fields: storeId, apiToken, products',
                received: Object.keys(req.body)
            });
        }

        if (!Array.isArray(products) || products.length === 0) {
            return res.status(400).json({
                error: 'Products must be a non-empty array',
                received: typeof products
            });
        }

        const syncManager = new EcwidSyncManager({
            storeId,
            apiToken,
            batchSize: options.batchSize || 25,
            maxRetries: options.maxRetries || 5,
            requestDelay: options.requestDelay || 300
        });

        console.log(`Starting sync for ${products.length} products...`);
        
        const results = await syncManager.syncProducts(products);
        
        res.json({
            success: true,
            message: `Sync completed successfully`,
            summary: results.summary,
            processed: results.results.length,
            errors: results.errors,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Sync error:', error);
        res.status(500).json({
            success: false,
            error: 'Sync failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint per sincronizzazione singolo prodotto (utile per test)
app.post('/api/sync-single', async (req, res) => {
    try {
        const { storeId, apiToken, product } = req.body;
        
        if (!storeId || !apiToken || !product) {
            return res.status(400).json({
                error: 'Missing required fields: storeId, apiToken, product'
            });
        }

        const syncManager = new EcwidSyncManager({ storeId, apiToken });
        const result = await syncManager.upsertProduct(product);
        
        res.json({
            success: true,
            result,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Single sync error:', error);
        res.status(500).json({
            success: false,
            error: 'Single product sync failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Error handler globale
app.use((error, req, res, next) => {
    console.error('Global error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.originalUrl,
        available_endpoints: [
            'GET /health',
            'GET /api/status', 
            'POST /api/test-connection',
            'POST /api/sync',
            'POST /api/sync-single'
        ],
        timestamp: new Date().toISOString()
    });
});

// Avvio server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 Ecwid Sync Server Successfully Started!');
    console.log(`📊 Server running on port: ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`🔄 Sync endpoint: http://localhost:${PORT}/api/sync`);
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
