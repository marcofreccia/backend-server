const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class EcwidSyncManager {
    constructor(config) {
        this.config = {
            storeId: config.storeId,
            apiToken: config.apiToken,
            baseUrl: `https://app.ecwid.com/api/v3/${config.storeId}`,
            maxRetries: 5,
            retryDelay: 1000, // Start with 1 second
            batchSize: 25,
            requestDelay: 250, // 4 requests per second max
            logFile: 'ecwid-sync.log',
            ...config
        };
        
        this.stats = {
            success: 0,
            created: 0,
            updated: 0,
            ignored: 0,
            error: 0,
            errorSKUs: []
        };
        
        this.lastProcessedIndex = 0;
    }

    // Enhanced logging
    async log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}\n`;
        
        console.log(logMessage.trim());
        
        try {
            await fs.appendFile(this.config.logFile, logMessage);
        } catch (error) {
            console.error('Failed to write to log file:', error.message);
        }
    }

    // Exponential backoff retry wrapper
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
                
                // Don't retry on certain errors
                if (error.response?.status === 404 || error.response?.status === 401) {
                    throw error;
                }
                
                const delay = this.config.retryDelay * Math.pow(2, attempt - 1);
                await this.log(`⚠ ${context} failed (attempt ${attempt}/${this.config.maxRetries}): ${error.message}. Retrying in ${delay}ms...`, 'WARN');
                
                if (attempt < this.config.maxRetries) {
                    await this.sleep(delay);
                }
            }
        }
        
        throw lastError;
    }

    // Enhanced API request method
    async makeRequest(method, endpoint, data = null, headers = {}) {
        const url = `${this.config.baseUrl}${endpoint}`;
        
        const config = {
            method,
            url,
            headers: {
                'Authorization': `Bearer ${this.config.apiToken}`,
                'Content-Type': 'application/json',
                ...headers
            },
            timeout: 30000, // 30 second timeout
            validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        };
        
        if (data) {
            config.data = data;
        }
        
        const response = await axios(config);
        
        // Handle non-JSON responses (the main issue you encountered)
        if (response.headers['content-type']?.includes('text/html')) {
            throw new Error(`Server returned HTML instead of JSON. Status: ${response.status}, URL: ${url}`);
        }
        
        // Validate JSON response
        if (typeof response.data !== 'object') {
            throw new Error(`Invalid JSON response from ${url}`);
        }
        
        if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}: ${response.data?.errorMessage || 'Unknown error'}`);
        }
        
        return response.data;
    }

    // Test API connectivity
    async testConnection() {
        try {
            await this.log('Testing API connection...');
            const profile = await this.makeRequest('GET', '/profile');
            await this.log(`✓ Connected to store: ${profile.generalInfo?.storeUrl || 'Unknown'}`);
            return true;
        } catch (error) {
            await this.log(`✗ API connection failed: ${error.message}`, 'ERROR');
            return false;
        }
    }

    // Search for existing product
    async searchProduct(sku) {
        return await this.withRetry(async () => {
            const data = await this.makeRequest('GET', `/products?sku=${encodeURIComponent(sku)}`);
            return data.items?.[0] || null;
        }, `Search product ${sku}`);
    }

    // Validate and process image URL
    async processImageUrl(imageUrl) {
        if (!imageUrl || typeof imageUrl !== 'string') {
            return null;
        }
        
        // Validate URL format
        try {
            new URL(imageUrl);
        } catch {
            await this.log(`Invalid image URL format: ${imageUrl}`, 'WARN');
            return null;
        }
        
        // Check if image is accessible
        try {
            const response = await axios.head(imageUrl, { timeout: 5000 });
            const contentType = response.headers['content-type'];
            
            if (!contentType?.startsWith('image/')) {
                await this.log(`URL is not an image: ${imageUrl} (${contentType})`, 'WARN');
                return null;
            }
            
            return imageUrl;
        } catch (error) {
            await this.log(`Image URL not accessible: ${imageUrl} - ${error.message}`, 'WARN');
            return null;
        }
    }

    // Upload product image
    async uploadProductImage(productId, imageUrl, isMain = false) {
        if (!imageUrl) return null;
        
        const validatedUrl = await this.processImageUrl(imageUrl);
        if (!validatedUrl) return null;
        
        return await this.withRetry(async () => {
            const endpoint = isMain 
                ? `/products/${productId}/image`
                : `/products/${productId}/gallery`;
            
            const imageData = {
                externalUrl: validatedUrl
            };
            
            return await this.makeRequest('POST', endpoint, imageData);
        }, `Upload image for product ${productId}`);
    }

    // Create or update product
    async upsertProduct(productData) {
        const sku = productData.sku;
        let existingProduct = null;
        let isUpdate = false;
        
        try {
            // Search for existing product
            existingProduct = await this.searchProduct(sku);
            isUpdate = !!existingProduct;
            
            // Prepare product data
            const productPayload = {
                name: productData.name || 'Untitled Product',
                sku: sku,
                price: parseFloat(productData.price) || 0,
                enabled: productData.enabled !== false,
                description: productData.description || '',
                weight: productData.weight || 0,
                ...productData
            };
            
            // Remove image URLs from main payload - handle separately
            const mainImageUrl = productPayload.defaultDisplayedPriceFormatted;
            const galleryImages = productPayload.galleryImages || [];
            delete productPayload.defaultDisplayedPriceFormatted;
            delete productPayload.galleryImages;
            
            let result;
            
            if (isUpdate) {
                // Update existing product
                result = await this.withRetry(async () => {
                    return await this.makeRequest('PUT', `/products/${existingProduct.id}`, productPayload);
                }, `Update product ${sku}`);
                
                this.stats.updated++;
            } else {
                // Create new product
                result = await this.withRetry(async () => {
                    return await this.makeRequest('POST', '/products', productPayload);
                }, `Create product ${sku}`);
                
                this.stats.created++;
            }
            
            const productId = result.id || existingProduct?.id;
            
            // Handle images separately with error tolerance
            if (productId) {
                // Upload main image
                if (mainImageUrl) {
                    try {
                        await this.uploadProductImage(productId, mainImageUrl, true);
                        await this.log(`✓ Main image uploaded for ${sku}`);
                    } catch (error) {
                        await this.log(`⚠ Failed to upload main image for ${sku}: ${error.message}`, 'WARN');
                    }
                }
                
                // Upload gallery images
                for (let i = 0; i < galleryImages.length && i < 10; i++) {
                    try {
                        await this.uploadProductImage(productId, galleryImages[i], false);
                        await this.sleep(100); // Small delay between images
                    } catch (error) {
                        await this.log(`⚠ Failed to upload gallery image ${i+1} for ${sku}: ${error.message}`, 'WARN');
                    }
                }
            }
            
            this.stats.success++;
            await this.log(`✓ ${isUpdate ? 'Updated' : 'Created'} product: ${sku}`);
            
            return result;
            
        } catch (error) {
            this.stats.error++;
            this.stats.errorSKUs.push({
                sku: sku,
                step: existingProduct ? 'upsert' : 'search',
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            await this.log(`✗ Failed to process ${sku}: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    // Process products in batches
    async syncProducts(products) {
        if (!Array.isArray(products) || products.length === 0) {
            throw new Error('No products provided for sync');
        }
        
        // Test connection first
        const connectionOk = await this.testConnection();
        if (!connectionOk) {
            throw new Error('Cannot establish API connection');
        }
        
        await this.log(`Starting sync of ${products.length} products in batches of ${this.config.batchSize}`);
        
        // Resume from last processed index if available
        const startIndex = this.lastProcessedIndex;
        const totalBatches = Math.ceil((products.length - startIndex) / this.config.batchSize);
        
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchStart = startIndex + (batchIndex * this.config.batchSize);
            const batchEnd = Math.min(batchStart + this.config.batchSize, products.length);
            const batch = products.slice(batchStart, batchEnd);
            
            await this.log(`Processing batch ${batchIndex + 1}/${totalBatches} (products ${batchStart + 1}-${batchEnd})`);
            
            // Process batch with individual error handling
            for (const product of batch) {
                try {
                    await this.upsertProduct(product);
                    this.lastProcessedIndex++;
                } catch (error) {
                    // Continue processing even if one product fails
                    await this.log(`Skipping product due to error, continuing with batch...`, 'WARN');
                }
                
                // Rate limiting delay
                await this.sleep(this.config.requestDelay);
            }
            
            // Save progress
            await this.saveProgress();
            
            // Batch delay to avoid overwhelming the API
            if (batchIndex < totalBatches - 1) {
                await this.log(`Batch ${batchIndex + 1} completed. Waiting before next batch...`);
                await this.sleep(2000); // 2 second delay between batches
            }
        }
        
        await this.generateReport();
        return this.stats;
    }

    // Save progress to file
    async saveProgress() {
        const progressData = {
            lastProcessedIndex: this.lastProcessedIndex,
            stats: this.stats,
            timestamp: new Date().toISOString()
        };
        
        try {
            await fs.writeFile('sync-progress.json', JSON.stringify(progressData, null, 2));
        } catch (error) {
            await this.log(`Failed to save progress: ${error.message}`, 'WARN');
        }
    }

    // Load previous progress
    async loadProgress() {
        try {
            const progressData = JSON.parse(await fs.readFile('sync-progress.json', 'utf8'));
            this.lastProcessedIndex = progressData.lastProcessedIndex || 0;
            await this.log(`Resumed from product index: ${this.lastProcessedIndex}`);
        } catch (error) {
            await this.log('No previous progress found, starting from beginning');
            this.lastProcessedIndex = 0;
        }
    }

    // Generate final report
    async generateReport() {
        const report = {
            summary: {
                success: this.stats.success,
                created: this.stats.created,
                updated: this.stats.updated,
                ignored: this.stats.ignored,
                error: this.stats.error,
                total_processed: this.stats.success + this.stats.error
            },
            errors: this.stats.errorSKUs,
            timestamp: new Date().toISOString()
        };
        
        const reportFile = `sync-report-${Date.now()}.json`;
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
        
        await this.log(`\n=== SYNC COMPLETED ===`);
        await this.log(`Total Processed: ${report.summary.total_processed}`);
        await this.log(`Successful: ${report.summary.success}`);
        await this.log(`- Created: ${report.summary.created}`);
        await this.log(`- Updated: ${report.summary.updated}`);
        await this.log(`Errors: ${report.summary.error}`);
        await this.log(`Report saved to: ${reportFile}`);
        
        return report;
    }

    // Utility method for delays
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Usage Example
async function main() {
    const syncManager = new EcwidSyncManager({
        storeId: 'YOUR_STORE_ID',
        apiToken: 'YOUR_API_TOKEN',
        batchSize: 25, // Smaller batches for stability
        maxRetries: 5,
        requestDelay: 300, // Slightly slower to avoid rate limits
    });
    
    try {
        // Load any previous progress
        await syncManager.loadProgress();
        
        // Your product data array
        const products = [
            {
                sku: 'PRODUCT-001',
                name: 'Sample Product',
                price: 29.99,
                description: 'Product description',
                defaultDisplayedPriceFormatted: 'https://example.com/image.jpg',
                galleryImages: [
                    'https://example.com/gallery1.jpg',
                    'https://example.com/gallery2.jpg'
                ],
                enabled: true
            },
            // ... more products
        ];
        
        // Start sync
        const results = await syncManager.syncProducts(products);
        console.log('Sync completed successfully:', results.summary);
        
    } catch (error) {
        console.error('Sync failed:', error.message);
        await syncManager.log(`FATAL ERROR: ${error.message}`, 'ERROR');
    }
}

// Export for use as module
module.exports = { EcwidSyncManager };

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}
