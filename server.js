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

// Logging middleware con timestamp
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
            maxRetries: 7, // Aumentato per maggiore resilienza
            retryDelay: 1500, // Aumentato per sincronizzazione più lenta
            batchSize: 10, // Ridotto per evitare problemi
            requestDelay: 500, // Aumentato significativamente (era 250ms)
            logFile: 'ecwid-sync.log',
            minPrice: 40.0, // Filtro prezzo minimo
            priceMultiplier: 2.0, // Raddoppia i prezzi
            ...config
        };

        this.stats = {
            success: 0,
            created: 0,
            updated: 0,
            ignored: 0,
            filtered: 0, // Nuovo: prodotti scartati per prezzo
            error: 0,
            errorSKUs: [],
            startTime: new Date().toISOString()
        };

        this.lastProcessedIndex = 0;
        this.logs = [];

        // Rate limiting avanzato
        this.lastRequestTime = 0;
        this.requestQueue = [];
        this.isProcessingQueue = false;
    }

    // Logging avanzato con persistenza opzionale
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
        
        // Mantieni solo gli ultimi 2000 log in memoria (aumentato)
        if (this.logs.length > 2000) {
            this.logs = this.logs.slice(-2000);
        }

        // Persisti log critici su file (opzionale)
        if (level === 'ERROR' || level === 'CRITICAL') {
            try {
                const logLine = `${timestamp} [${level}] ${message}\n`;
                await fs.appendFile(this.config.logFile, logLine);
            } catch (err) {
                console.error('Failed to write to log file:', err.message);
            }
        }
    }

    // Rate limiting intelligente con coda
    async enforceRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.config.requestDelay) {
            const waitTime = this.config.requestDelay - timeSinceLastRequest;
            await this.sleep(waitTime);
        }
        
        this.lastRequestTime = Date.now();
    }

    // Retry con backoff esponenziale migliorato
    async withRetry(operation, context = '') {
        let lastError;
        
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                await this.enforceRateLimit();
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
                
                // Backoff esponenziale più aggressivo per stabilità
                const delay = Math.min(
                    this.config.retryDelay * Math.pow(2, attempt - 1) + Math.random() * 1000,
                    60000 // Max 1 minuto
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

    // Request API con gestione errori avanzata e timeout dinamico
    async makeRequest(method, endpoint, data = null, headers = {}, timeout = 90000) {
        const url = `${this.config.baseUrl}${endpoint}`;
        
        const config = {
            method,
            url,
            headers: {
                'Authorization': `Bearer ${this.config.apiToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'MSY-Ecwid-Sync/2.0-Enhanced',
                'Accept': 'application/json',
                ...headers
            },
            timeout,
            validateStatus: (status) => status < 500, // 5xx sono sempre retry-able
            maxRedirects: 5
        };

        if (data) {
            config.data = data;
        }

        const response = await axios(config);

        // Gestione risposte HTML invece di JSON
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html') && !contentType.includes('application/json')) {
            throw new Error(`Server returned HTML instead of JSON. Status: ${response.status}, URL: ${url}`);
        }

        // Validazione JSON response più robusta
        if (response.data === null || response.data === undefined) {
            throw new Error(`Null response from ${url}`);
        }

        // Gestione errori HTTP 4xx con dettagli migliorati
        if (response.status >= 400) {
            const errorMsg = response.data?.errorMessage ||
                           response.data?.message ||
                           response.data?.error ||
                           `HTTP ${response.status}: ${response.statusText}`;
            
            const error = new Error(errorMsg);
            error.status = response.status;
            error.response = response;
            throw error;
        }

        return response.data;
    }

    // Test connessione migliorato con diagnostica
    async testConnection() {
        try {
            await this.log('🔍 Testing API connection with enhanced diagnostics...');
            
            const profile = await this.makeRequest('GET', '/profile');
            
            const storeInfo = {
                storeUrl: profile.generalInfo?.storeUrl,
                storeName: profile.generalInfo?.storeName,
                storeId: profile.generalInfo?.storeId,
                plan: profile.account?.accountName,
                country: profile.generalInfo?.storeLocation?.country
            };
            
            await this.log(`✅ Connected successfully to store: ${storeInfo.storeName} (${storeInfo.storeUrl})`);
            await this.log(`📊 Plan: ${storeInfo.plan} | Store ID: ${storeInfo.storeId} | Location: ${storeInfo.country}`);
            
            return { success: true, store: storeInfo };
            
        } catch (error) {
            await this.log(`❌ API connection failed: ${error.message}`, 'ERROR');
            if (error.response) {
                await this.log(`📊 Response Status: ${error.response.status} ${error.response.statusText}`, 'ERROR');
            }
            return { success: false, error: error.message, status: error.status };
        }
    }

    // Filtro prodotti con validazione prezzo migliorata
    validateAndFilterProduct(productData) {
        const originalPrice = parseFloat(productData.price) || 0;
        
        // Filtra prodotti sotto il prezzo minimo
        if (originalPrice < this.config.minPrice) {
            this.stats.filtered++;
            return {
                isValid: false,
                reason: `Price ${originalPrice}€ is below minimum ${this.config.minPrice}€`
            };
        }

        // Applica moltiplicatore prezzo
        const newPrice = originalPrice * this.config.priceMultiplier;
        
        return {
            isValid: true,
            processedProduct: {
                ...productData,
                price: newPrice,
                originalPrice: originalPrice
            }
        };
    }

    // Ricerca prodotto esistente con gestione cache
    async searchProduct(sku) {
        return await this.withRetry(async () => {
            const data = await this.makeRequest('GET', `/products?sku=${encodeURIComponent(sku)}&limit=1`);
            return data.items?.[0] || null;
        }, `Search product ${sku}`);
    }

    // Validazione e processamento URL immagini migliorato
    async processImageUrl(imageUrl, productSku) {
        if (!imageUrl || typeof imageUrl !== 'string') {
            return null;
        }

        // Validazione formato URL più robusta
        try {
            const url = new URL(imageUrl);
            if (!['http:', 'https:'].includes(url.protocol)) {
                await this.log(`Invalid protocol for ${productSku}: ${url.protocol}`, 'WARN');
                return null;
            }
        } catch (error) {
            await this.log(`Invalid image URL format for ${productSku}: ${imageUrl}`, 'WARN');
            return null;
        }

        // Test accessibilità immagine con timeout più lungo
        try {
            const response = await axios.head(imageUrl, {
                timeout: 15000, // Aumentato timeout
                maxRedirects: 3,
                validateStatus: (status) => status < 400
            });

            const contentType = response.headers['content-type'];
            if (!contentType?.startsWith('image/')) {
                await this.log(`URL is not an image for ${productSku}: ${imageUrl} (${contentType})`, 'WARN');
                return null;
            }

            const contentLength = parseInt(response.headers['content-length'] || '0');
            if (contentLength > 25 * 1024 * 1024) { // Max 25MB (aumentato)
                await this.log(`Image too large for ${productSku}: ${imageUrl} (${contentLength} bytes)`, 'WARN');
                return null;
            }

            return imageUrl;

        } catch (error) {
            await this.log(`Image URL not accessible for ${productSku}: ${imageUrl} - ${error.message}`, 'WARN');
            return null;
        }
    }

    // Upload immagine prodotto con retry migliorato
    async uploadProductImage(productId, imageUrl, isMain = false, productSku = '') {
        if (!imageUrl) return null;

        const validatedUrl = await this.processImageUrl(imageUrl, productSku);
        if (!validatedUrl) return null;

        return await this.withRetry(async () => {
            const endpoint = isMain
                ? `/products/${productId}/image`
                : `/products/${productId}/gallery`;

            const imageData = { 
                externalUrl: validatedUrl,
                alt: `${productSku} - ${isMain ? 'Main' : 'Gallery'} Image`
            };

            const result = await this.makeRequest('POST', endpoint, imageData, {}, 120000); // Timeout 2 minuti per immagini
            
            await this.log(`✅ ${isMain ? 'Main' : 'Gallery'} image uploaded for ${productSku}`);
            return result;

        }, `Upload ${isMain ? 'main' : 'gallery'} image for product ${productId}`);
    }

    // Creazione/aggiornamento prodotto con validazione completa
    async upsertProduct(productData) {
        const sku = productData.sku;

        if (!sku || !productData.name) {
            this.stats.error++;
            await this.log(`❌ Missing required fields (SKU or name) for product`, 'ERROR');
            return { success: false, error: 'Missing required fields: SKU and name are mandatory' };
        }

        // Validazione e filtro prezzo
        const validation = this.validateAndFilterProduct(productData);
        if (!validation.isValid) {
            this.stats.filtered++;
            await this.log(`🔽 Filtered product ${sku}: ${validation.reason}`);
            return { 
                success: false, 
                filtered: true, 
                reason: validation.reason,
                sku 
            };
        }

        const processedProduct = validation.processedProduct;

        let existingProduct = null;
        let isUpdate = false;

        try {
            // Ricerca prodotto esistente
            existingProduct = await this.searchProduct(sku);
            isUpdate = !!existingProduct;

            // Preparazione dati prodotto ottimizzati
            const productPayload = {
                name: processedProduct.name || 'Untitled Product',
                sku: sku,
                price: processedProduct.price,
                enabled: processedProduct.enabled !== false,
                description: processedProduct.description || '',
                weight: parseFloat(processedProduct.weight) || 0,
                quantity: parseInt(processedProduct.quantity) >= 0 ? parseInt(processedProduct.quantity) : 0,
                categoryIds: processedProduct.categoryIds || [],
                attributes: processedProduct.attributes || [],
                // Aggiungi meta informazioni per tracking
                seoTitle: processedProduct.seoTitle || processedProduct.name,
                seoDescription: processedProduct.seoDescription || processedProduct.description?.substring(0, 160),
                // Tracking prezzo originale nella descrizione per reference
                originalPriceNote: `Original price: €${processedProduct.originalPrice}`,
                ...processedProduct
            };

            // Rimuovi campi immagine dal payload principale per gestirli separatamente
            const mainImageUrl = productPayload.mainImageUrl || productPayload.defaultDisplayedPriceFormatted;
            const galleryImages = productPayload.galleryImages || [];
            delete productPayload.mainImageUrl;
            delete productPayload.defaultDisplayedPriceFormatted;
            delete productPayload.galleryImages;
            delete productPayload.originalPrice; // Remove from final payload

            let result;

            if (isUpdate) {
                // Aggiornamento prodotto esistente
                result = await this.withRetry(async () => {
                    return await this.makeRequest('PUT', `/products/${existingProduct.id}`, productPayload);
                }, `Update product ${sku}`);
                this.stats.updated++;
                await this.log(`🔄 Updated existing product: ${sku} (ID: ${existingProduct.id}) - Price: €${processedProduct.originalPrice} → €${processedProduct.price}`);
            } else {
                // Creazione nuovo prodotto
                result = await this.withRetry(async () => {
                    return await this.makeRequest('POST', '/products', productPayload);
                }, `Create product ${sku}`);
                this.stats.created++;
                await this.log(`🆕 Created new product: ${sku} (ID: ${result.id}) - Price: €${processedProduct.originalPrice} → €${processedProduct.price}`);
            }

            const productId = result.id || existingProduct?.id;

            // Gestione immagini con tolleranza agli errori migliorata
            if (productId && (mainImageUrl || galleryImages.length > 0)) {
                await this.log(`📸 Processing images for product ${sku}...`);

                // Upload immagine principale con fallback
                if (mainImageUrl) {
                    try {
                        await this.uploadProductImage(productId, mainImageUrl, true, sku);
                        await this.sleep(300); // Pausa tra upload per stabilità
                    } catch (error) {
                        await this.log(`⚠️ Failed to upload main image for ${sku}: ${error.message} (product still created successfully)`, 'WARN');
                    }
                }

                // Upload immagini gallery con limite e fallback
                const maxGalleryImages = Math.min(galleryImages.length, 15); // Limite aumentato
                for (let i = 0; i < maxGalleryImages; i++) {
                    try {
                        await this.uploadProductImage(productId, galleryImages[i], false, sku);
                        await this.sleep(400); // Pausa più lunga tra immagini gallery
                    } catch (error) {
                        await this.log(`⚠️ Failed to upload gallery image ${i+1} for ${sku}: ${error.message}`, 'WARN');
                        // Continua con le altre immagini
                    }
                }

                if (mainImageUrl || galleryImages.length > 0) {
                    await this.log(`✅ Image processing completed for ${sku}`);
                }
            }

            this.stats.success++;
            return {
                success: true,
                action: isUpdate ? 'updated' : 'created',
                productId,
                sku,
                originalPrice: processedProduct.originalPrice,
                newPrice: processedProduct.price
            };

        } catch (error) {
            this.stats.error++;
            this.stats.errorSKUs.push({
                sku: sku,
                step: existingProduct ? 'upsert' : 'search',
                error: error.message,
                status: error.status,
                timestamp: new Date().toISOString()
            });

            await this.log(`❌ Failed to process ${sku}: ${error.message}`, 'ERROR');
            return {
                success: false,
                error: error.message,
                status: error.status,
                sku
            };
        }
    }

    // Sincronizzazione prodotti in batch con gestione avanzata
    async syncProducts(products, onProgress = null) {
        if (!Array.isArray(products) || products.length === 0) {
            throw new Error('No products provided for sync');
        }

        // Test connessione iniziale
        const connectionTest = await this.testConnection();
        if (!connectionTest.success) {
            throw new Error(`Cannot establish API connection: ${connectionTest.error}`);
        }

        await this.log(`🚀 Starting enhanced sync of ${products.length} products in batches of ${this.config.batchSize}`);
        await this.log(`⚙️ Configuration: Min Price: €${this.config.minPrice}, Price Multiplier: ${this.config.priceMultiplier}x, Request Delay: ${this.config.requestDelay}ms`);

        const startIndex = this.lastProcessedIndex;
        const totalBatches = Math.ceil((products.length - startIndex) / this.config.batchSize);
        const results = [];

        let processedCount = 0;
        let skippedCount = 0;

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchStart = startIndex + (batchIndex * this.config.batchSize);
            const batchEnd = Math.min(batchStart + this.config.batchSize, products.length);
            const batch = products.slice(batchStart, batchEnd);

            await this.log(`📦 Processing batch ${batchIndex + 1}/${totalBatches} (products ${batchStart + 1}-${batchEnd})`);

            // Processamento batch con gestione errori individuali
            for (const product of batch) {
                try {
                    const result = await this.upsertProduct(product);
                    results.push(result);
                    
                    if (result.success) {
                        processedCount++;
                    } else if (result.filtered) {
                        skippedCount++;
                    }

                    this.lastProcessedIndex++;

                    // Callback progresso opzionale
                    if (onProgress) {
                        onProgress({
                            processed: this.lastProcessedIndex,
                            successful: processedCount,
                            skipped: skippedCount,
                            total: products.length,
                            current: product.sku,
                            batch: batchIndex + 1,
                            totalBatches: totalBatches,
                            stats: { ...this.stats }
                        });
                    }

                    // Rate limiting tra prodotti
                    await this.sleep(this.config.requestDelay);

                } catch (error) {
                    await this.log(`💥 Critical error processing ${product.sku}: ${error.message}`, 'CRITICAL');
                    results.push({
                        success: false,
                        error: error.message,
                        sku: product.sku,
                        critical: true
                    });
                }
            }

            // Pausa più lunga tra batch per maggiore stabilità
            if (batchIndex < totalBatches - 1) {
                const batchDelay = 3000 + (Math.random() * 2000); // 3-5 secondi casuali
                await this.log(`⏸️ Batch ${batchIndex + 1} completed. Waiting ${batchDelay}ms before next batch...`);
                await this.sleep(batchDelay);
            }
        }

        const finalReport = await this.generateReport();
        
        await this.log(`🎉 Enhanced sync completed! Processed: ${processedCount}, Skipped: ${skippedCount}, Errors: ${this.stats.error}`);
        
        return {
            success: true,
            summary: finalReport.summary,
            results,
            errors: this.stats.errorSKUs,
            logs: this.logs.slice(-100) // Ultimi 100 log per review
        };
    }

    // Generazione report finale migliorato
    async generateReport() {
        const endTime = new Date().toISOString();
        const duration = Date.now() - Date.parse(this.stats.startTime);

        const report = {
            summary: {
                success: this.stats.success,
                created: this.stats.created,
                updated: this.stats.updated,
                ignored: this.stats.ignored,
                filtered: this.stats.filtered,
                error: this.stats.error,
                total_processed: this.stats.success + this.stats.error,
                total_input: this.stats.success + this.stats.error + this.stats.filtered,
                success_rate: ((this.stats.success / (this.stats.success + this.stats.error)) * 100).toFixed(2) + '%',
                duration_ms: duration,
                duration_human: this.formatDuration(duration),
                start_time: this.stats.startTime,
                end_time: endTime,
                config: {
                    batch_size: this.config.batchSize,
                    request_delay: this.config.requestDelay,
                    min_price: this.config.minPrice,
                    price_multiplier: this.config.priceMultiplier
                }
            },
            errors: this.stats.errorSKUs,
            logs: this.logs.slice(-50)
        };

        await this.log(`\n📊 === ENHANCED SYNC REPORT ===`);
        await this.log(`⏱️  Duration: ${report.summary.duration_human}`);
        await this.log(`📈 Total Input: ${report.summary.total_input} products`);
        await this.log(`✅ Successful: ${report.summary.success} (Created: ${report.summary.created}, Updated: ${report.summary.updated})`);
        await this.log(`🔽 Filtered: ${report.summary.filtered} (below €${this.config.minPrice})`);
        await this.log(`❌ Errors: ${report.summary.error}`);
        await this.log(`📊 Success Rate: ${report.summary.success_rate}`);
        await this.log(`⚙️  Config: Batch ${this.config.batchSize}, Delay ${this.config.requestDelay}ms, Min €${this.config.minPrice}, ${this.config.priceMultiplier}x price`);

        return report;
    }

    // Utility per formattazione durata
    formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    // Get current status migliorato
    getStatus() {
        return {
            stats: { ...this.stats },
            lastProcessedIndex: this.lastProcessedIndex,
            recentLogs: this.logs.slice(-10),
            config: {
                batchSize: this.config.batchSize,
                requestDelay: this.config.requestDelay,
                minPrice: this.config.minPrice,
                priceMultiplier: this.config.priceMultiplier
            },
            isHealthy: this.stats.error / Math.max(this.stats.success + this.stats.error, 1) < 0.1 // Meno del 10% errori
        };
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
        service: 'Ecwid Enhanced Sync Server',
        version: '2.0.0'
    });
});

// Status generale del servizio migliorato
app.get('/api/status', (req, res) => {
    res.json({
        service: 'Ecwid Enhanced Sync Server',
        status: 'running',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        features: [
            'Price filtering (min €40)',
            'Price doubling',
            'Enhanced rate limiting',
            'Reduced batch processing',
            'Advanced error handling',
            'Image validation & upload',
            'Retry logic with exponential backoff',
            'Comprehensive logging'
        ],
        endpoints: {
            sync: 'POST /api/sync',
            'sync-single': 'POST /api/sync-single',
            test: 'POST /api/test-connection',
            status: 'GET /api/status',
            health: 'GET /health'
        },
        configuration: {
            default_batch_size: 10,
            default_request_delay: '500ms',
            min_price_filter: '€40',
            price_multiplier: '2x'
        }
    });
});

// Test connessione Ecwid migliorato
app.post('/api/test-connection', async (req, res) => {
    try {
        const { storeId, apiToken } = req.body;
        
        if (!storeId || !apiToken) {
            return res.status(400).json({
                error: 'Missing required fields: storeId, apiToken',
                required: ['storeId', 'apiToken'],
                received: Object.keys(req.body)
            });
        }

        const syncManager = new EcwidSyncManager({ storeId, apiToken });
        const result = await syncManager.testConnection();
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Enhanced connection test successful',
                store: result.store,
                configuration: syncManager.config,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(result.status || 400).json({
                success: false,
                error: result.error,
                status: result.status,
                timestamp: new Date().toISOString()
            });
        }

    } catch (error) {
        console.error('Enhanced connection test error:', error);
        res.status(500).json({
            success: false,
            error: 'Connection test failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Sincronizzazione principale con tutte le ottimizzazioni
app.post('/api/sync', async (req, res) => {
    try {
        const { storeId, apiToken, products, options = {} } = req.body;
        
        if (!storeId || !apiToken || !products) {
            return res.status(400).json({
                error: 'Missing required fields: storeId, apiToken, products',
                required: ['storeId', 'apiToken', 'products'],
                received: Object.keys(req.body)
            });
        }

        if (!Array.isArray(products) || products.length === 0) {
            return res.status(400).json({
                error: 'Products must be a non-empty array',
                received: typeof products,
                length: products?.length || 0
            });
        }

        const syncManager = new EcwidSyncManager({
            storeId,
            apiToken,
            batchSize: options.batchSize || 10, // Default ridotto
            maxRetries: options.maxRetries || 7,
            requestDelay: options.requestDelay || 500, // Default aumentato
            minPrice: options.minPrice || 40.0,
            priceMultiplier: options.priceMultiplier || 2.0
        });

        console.log(`🚀 Starting enhanced sync for ${products.length} products with optimizations...`);
        
        const results = await syncManager.syncProducts(products, (progress) => {
            // Log progress periodicamente
            if (progress.processed % 10 === 0 || progress.processed === progress.total) {
                console.log(`📊 Progress: ${progress.processed}/${progress.total} (${Math.round(progress.processed/progress.total*100)}%) - Success: ${progress.successful}, Skipped: ${progress.skipped}`);
            }
        });

        res.json({
            success: true,
            message: `Enhanced sync completed successfully`,
            summary: results.summary,
            processed: results.results.length,
            configuration: syncManager.config,
            errors: results.errors,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Enhanced sync error:', error);
        res.status(500).json({
            success: false,
            error: 'Enhanced sync failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint per sincronizzazione singolo prodotto ottimizzato
app.post('/api/sync-single', async (req, res) => {
    try {
        const { storeId, apiToken, product, options = {} } = req.body;
        
        if (!storeId || !apiToken || !product) {
            return res.status(400).json({
                error: 'Missing required fields: storeId, apiToken, product',
                required: ['storeId', 'apiToken', 'product'],
                received: Object.keys(req.body)
            });
        }

        const syncManager = new EcwidSyncManager({ 
            storeId, 
            apiToken,
            minPrice: options.minPrice || 40.0,
            priceMultiplier: options.priceMultiplier || 2.0
        });

        const result = await syncManager.upsertProduct(product);
        
        res.json({
            success: true,
            result,
            configuration: {
                minPrice: syncManager.config.minPrice,
                priceMultiplier: syncManager.config.priceMultiplier
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Enhanced single sync error:', error);
        res.status(500).json({
            success: false,
            error: 'Single product sync failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Error handler globale migliorato
app.use((error, req, res, next) => {
    console.error('Global error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: error.message,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

// 404 handler migliorato
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.originalUrl,
        method: req.method,
        available_endpoints: [
            'GET /health - Health check',
            'GET /api/status - Service status with features',
            'POST /api/test-connection - Test Ecwid API connection',
            'POST /api/sync-single - Sync single product with optimizations',
            'POST /api/sync - Batch sync with all enhancements'
        ],
        documentation: 'Enhanced version with price filtering, doubling, and optimized rate limiting',
        timestamp: new Date().toISOString()
    });
});

// Avvio server con informazioni complete
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 === Ecwid Enhanced Sync Server Successfully Started ===');
    console.log(`📊 Server running on port: ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`🔄 Enhanced sync: http://localhost:${PORT}/api/sync`);
    console.log(`📡 Status: http://localhost:${PORT}/api/status`);
    console.log(`\n⚙️  === Enhanced Configuration ===`);
    console.log(`💰 Price Filter: Products below €40 will be filtered out`);
    console.log(`📈 Price Doubling: All prices multiplied by 2x (€20 → €40)`);
    console.log(`🐌 Rate Limiting: 500ms delay between requests (slower for stability)`);
    console.log(`📦 Batch Size: 10 products per batch (reduced from 25)`);
    console.log(`🔄 Max Retries: 7 attempts with exponential backoff`);
    console.log(`📸 Image Upload: Enhanced validation and error handling`);
    console.log(`📝 Logging: Comprehensive tracking and error reporting`);
    console.log(`\n⚡ Ready for enhanced product synchronization! 🎯\n`);
});

// Graceful shutdown migliorato
process.on('SIGTERM', () => {
    console.log('📴 Enhanced server shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed successfully');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('📴 Enhanced server shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed successfully');
        process.exit(0);
    });
});

module.exports = app;
