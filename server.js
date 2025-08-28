{
  "name": "msy-ecwid-hybrid-sync",
  "version": "1.0.0",
  "description": "Hybrid MSY to Ecwid product synchronization",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "node-fetch": "^2.6.7",
    "node-cron": "^3.0.2",
    "papaparse": "^5.4.1"
  },
  "engines": {
    "node": ">=16.0.0"
  },
  "keywords": ["ecwid", "msy", "sync"],
  "author": "Your Name",
  "license": "MIT"
}
📄 2. server.js COMPLETO AGGIORNATO:
javascript
const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAZIONE COMPLETA =====
const CONFIG = {
  // FONTI DATI MSY
  DATA_SOURCES: {
    CSV_URL: 'https://msy.madtec.be/price_list/pricelist_en.csv',
    JSON_URL: 'http://msy.madtec.be/price_list/pricelist_en.json',
  },
  
  // MODALITÀ E CONFIGURAZIONI
  SYNC_MODE: 'HYBRID',
  ECWID_STORE_ID: process.env.ECWID_STORE_ID || '29517085',
  ECWID_API_TOKEN: process.env.ECWID_API_TOKEN,
  ECWID_API_URL: `https://app.ecwid.com/api/v3/${process.env.ECWID_STORE_ID || '29517085'}`,
  
  // PARAMETRI DI VALIDAZIONE (MODIFICABILI)
  REQUIRE_IMAGES: false,                    // Non richiede immagini obbligatoriamente
  MIN_PRICE_THRESHOLD: 15,                 // Soglia prezzo minimo ridotta
  PRICE_MULTIPLIER: 2,                     // Moltiplicatore prezzo (MSY x2)
  
  // PARAMETRI BATCH E RATE LIMITING
  BATCH_SIZE: 5,                           // Batch più piccoli per evitare rate limiting
  BATCH_DELAY: 5000,                       // Delay aumentato (5 secondi)
  REQUEST_TIMEOUT: 45000,                  // Timeout richieste aumentato
  
  // USER AGENT E HEADERS
  USER_AGENT: 'MSY-Ecwid-Sync/1.0 (Railway Deployment)',
};

// ===== UTILITÀ PARSING =====
function parsePrice(price) {
  if (!price || price === null || price === undefined || price === '') return 0;
  const cleanPrice = String(price)
    .replace(/[^\d.,\-]/g, '')
    .replace(',', '.');
  const parsed = parseFloat(cleanPrice);
  return isNaN(parsed) ? 0 : Math.max(0, parsed);
}

function parseStock(stock) {
  if (!stock || stock === null || stock === undefined || stock === '') return 0;
  const cleanStock = String(stock).replace(/[^\d]/g, '');
  const parsed = parseInt(cleanStock, 10);
  return isNaN(parsed) ? 0 : Math.max(0, parsed);
}

function extractImages(product) {
  const imageFields = ['photo_1', 'photo_2', 'photo_3', 'photo_4', 'photo_5'];
  const images = [];
  
  for (const field of imageFields) {
    if (product[field]) {
      const url = String(product[field]).trim();
      if (url && url !== '' && (url.startsWith('http://') || url.startsWith('https://'))) {
        images.push(url);
      }
    }
  }
  return images;
}

// ===== CLASSE SYNC IBRIDA COMPLETA =====
class HybridMSYEcwidSync {
  constructor() {
    this.resetStats();
  }

  resetStats() {
    this.stats = {
      total: 0,
      processed: 0,
      created: 0,
      updated: 0,
      ignored: 0,
      errors: 0,
      reasons: {
        noImages: 0,
        lowPrice: 0,
        invalidData: 0,
        apiError: 0
      },
      source: null,
      startTime: null,
      endTime: null
    };
    this.errorSKUs = [];
  }

  // FETCH CSV CON PARSING MSY CORRETTO
  async fetchCSVProducts() {
    try {
      console.log('📊 Recupero CSV MSY...');
      const response = await fetch(CONFIG.DATA_SOURCES.CSV_URL, {
        timeout: CONFIG.REQUEST_TIMEOUT,
        headers: { 
          'User-Agent': CONFIG.USER_AGENT,
          'Accept': 'text/csv'
        }
      });
      
      if (!response.ok) {
        throw new Error(`CSV error: ${response.status} ${response.statusText}`);
      }
      
      const csvData = await response.text();
      console.log(`📊 CSV dimensione: ${csvData.length} caratteri`);
      
      // PARSING SPECIFICO PER FORMATO MSY
      const parsed = Papa.parse(csvData, {
        header: true,
        delimiter: ';',                      // MSY usa semicolon come separator
        skipEmptyLines: true,
        transformHeader: (header) => {
          // MAPPING ESATTO DEI CAMPI MSY
          const headerMap = {
            'Article no.': 'article_num',
            'Name': 'name',
            'Description': 'description',
            'Price': 'price',
            'VAT rate': 'vat_rate',
            'Currency': 'currency',
            'Stock': 'stock',
            '1. Photo': 'photo_1',
            '2. Photo': 'photo_2',
            '3. Photo': 'photo_3',
            '4. Photo': 'photo_4',
            '5. Photo': 'photo_5',
            'Main category': 'main_category',
            'Subcategory': 'subcategory',
            'EAN code / GTIN 13 code': 'ean',
            'Brand': 'brand',
            'weight': 'weight',
            'volume': 'volume',
            'height': 'height',
            'width': 'width',
            'length': 'length',
            'Advised Sales Price': 'advised_price'
          };
          
          const cleanHeader = header.replace(/"/g, '').trim();
          return headerMap[cleanHeader] || cleanHeader.toLowerCase().replace(/\s+/g, '_');
        }
      });
      
      if (parsed.errors && parsed.errors.length > 0) {
        console.warn('⚠️ Errori di parsing CSV:', parsed.errors);
      }
      
      const validProducts = parsed.data.filter(row => {
        return row && row.article_num && row.article_num.trim() !== '' &&
               row.price && row.price.trim() !== '' &&
               row.name && row.name.trim() !== '';
      });
      
      console.log(`✅ CSV: ${validProducts.length} prodotti validi trovati`);
      console.log(`📝 Primo prodotto esempio: ${validProducts[0]?.article_num} - ${validProducts[0]?.name}`);
      
      return validProducts;
      
    } catch (error) {
      console.error('❌ Errore CSV:', error.message);
      throw error;
    }
  }

  // FETCH JSON FALLBACK
  async fetchJSONProducts() {
    try {
      console.log('🔄 Recupero JSON MSY fallback...');
      const response = await fetch(CONFIG.DATA_SOURCES.JSON_URL, {
        timeout: CONFIG.REQUEST_TIMEOUT,
        headers: {
          'User-Agent': CONFIG.USER_AGENT,
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`JSON error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      if (!data || !data.price_list || !Array.isArray(data.price_list)) {
        throw new Error('JSON structure invalid - price_list not found');
      }
      
      console.log(`✅ JSON: ${data.price_list.length} prodotti`);
      return data.price_list;
      
    } catch (error) {
      console.error('❌ Errore JSON:', error.message);
      throw error;
    }
  }

  // NORMALIZZAZIONE PRODOTTO MSY → ECWID
  normalizeProduct(product) {
    try {
      // Validazione base
      if (!product || !product.article_num || !product.name || !product.price) {
        this.stats.reasons.invalidData++;
        return null;
      }

      const originalPrice = parsePrice(product.price);
      if (originalPrice <= 0) {
        this.stats.reasons.invalidData++;
        return null;
      }

      const finalPrice = originalPrice * CONFIG.PRICE_MULTIPLIER;
      
      // Filtro prezzo minimo DOPO il raddoppio
      if (finalPrice < CONFIG.MIN_PRICE_THRESHOLD) {
        this.stats.reasons.lowPrice++;
        return null;
      }

      // Estrazione immagini
      const images = extractImages(product);
      
      // Controllo immagini obbligatorie
      if (CONFIG.REQUIRE_IMAGES && images.length === 0) {
        this.stats.reasons.noImages++;
        return null;
      }

      // Stock validation
      const stockQuantity = parseStock(product.stock);

      return {
        sku: product.article_num.trim(),
        name: product.name.trim(),
        description: (product.description || '').trim(),
        price: Math.round(finalPrice * 100) / 100, // Arrotonda a 2 decimali
        quantity: stockQuantity,
        stock: stockQuantity,
        brand: (product.brand || '').trim(),
        category: (product.main_category || '').trim(),
        subcategory: (product.subcategory || '').trim(),
        ean: (product.ean || '').trim(),
        weight: product.weight || null,
        dimensions: {
          height: product.height || null,
          width: product.width || null,
          length: product.length || null,
          volume: product.volume || null
        },
        images: images,
        originalPrice: originalPrice,
        advisedPrice: parsePrice(product.advised_price) || null
      };
      
    } catch (error) {
      console.error(`❌ Errore normalizzazione prodotto ${product.article_num}:`, error);
      this.stats.reasons.invalidData++;
      return null;
    }
  }

  // RICERCA PRODOTTO ECWID ESISTENTE
  async searchEcwidProduct(sku) {
    try {
      const url = `${CONFIG.ECWID_API_URL}/products?sku=${encodeURIComponent(sku)}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${CONFIG.ECWID_API_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': CONFIG.USER_AGENT
        },
        timeout: 15000
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Ecwid token non autorizzato - verifica ECWID_API_TOKEN');
        }
        throw new Error(`Ecwid search error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.items && data.items.length > 0 ? data.items[0] : null;

    } catch (error) {
      console.error(`❌ Errore ricerca prodotto ${sku}:`, error.message);
      this.stats.reasons.apiError++;
      return null;
    }
  }

  // CREAZIONE/AGGIORNAMENTO PRODOTTO ECWID
  async upsertEcwidProduct(normalizedProduct, existingProduct = null) {
    try {
      const productData = {
        name: normalizedProduct.name,
        sku: normalizedProduct.sku,
        price: normalizedProduct.price,
        quantity: normalizedProduct.quantity,
        description: normalizedProduct.description,
        enabled: true,
        categories: normalizedProduct.category ? [{ name: normalizedProduct.category }] : [],
        weight: normalizedProduct.weight,
        dimensions: normalizedProduct.dimensions
      };

      // Aggiungi immagini se presenti
      if (normalizedProduct.images && normalizedProduct.images.length > 0) {
        productData.media = {
          images: normalizedProduct.images.slice(0, 5).map(url => ({ url }))
        };
      }

      let url, method;
      
      if (existingProduct) {
        // Aggiornamento prodotto esistente
        url = `${CONFIG.ECWID_API_URL}/products/${existingProduct.id}`;
        method = 'PUT';
      } else {
        // Creazione nuovo prodotto
        url = `${CONFIG.ECWID_API_URL}/products`;
        method = 'POST';
      }

      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${CONFIG.ECWID_API_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': CONFIG.USER_AGENT
        },
        body: JSON.stringify(productData),
        timeout: 20000
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ecwid ${method} error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      
      if (existingProduct) {
        this.stats.updated++;
        console.log(`🔄 ${normalizedProduct.sku}: Aggiornato (€${normalizedProduct.price})`);
      } else {
        this.stats.created++;
        console.log(`🆕 ${normalizedProduct.sku}: Creato (€${normalizedProduct.price})`);
      }

      return result;

    } catch (error) {
      this.stats.errors++;
      this.stats.reasons.apiError++;
      
      this.errorSKUs.push({
        sku: normalizedProduct.sku,
        step: existingProduct ? 'update' : 'create',
        error: error.message
      });
      
      console.error(`❌ ${normalizedProduct.sku}: ${error.message}`);
      throw error;
    }
  }

  // PROCESSAMENTO SINGOLO PRODOTTO
  async processProduct(product) {
    try {
      const normalized = this.normalizeProduct(product);
      if (!normalized) {
        this.stats.ignored++;
        return;
      }

      const existing = await this.searchEcwidProduct(normalized.sku);
      await this.upsertEcwidProduct(normalized, existing);
      
      this.stats.processed++;

    } catch (error) {
      // Errore già loggato in upsertEcwidProduct
      this.stats.errors++;
    }
  }

  // PROCESSAMENTO BATCH CON RATE LIMITING
  async processBatch(products) {
    const totalBatches = Math.ceil(products.length / CONFIG.BATCH_SIZE);
    
    console.log(`📦 Processamento in ${totalBatches} batch di ${CONFIG.BATCH_SIZE} prodotti`);
    console.log(`⏱️ Delay tra batch: ${CONFIG.BATCH_DELAY}ms`);

    for (let i = 0; i < products.length; i += CONFIG.BATCH_SIZE) {
      const currentBatch = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
      const batch = products.slice(i, i + CONFIG.BATCH_SIZE);
      
      console.log(`\n🚀 BATCH ${currentBatch}/${totalBatches} (${batch.length} prodotti)`);
      
      // Processamento parallelo del batch
      await Promise.all(batch.map(product => this.processProduct(product)));
      
      // Progress report
      const processedSoFar = Math.min(i + CONFIG.BATCH_SIZE, products.length);
      const progressPercent = Math.round((processedSoFar / products.length) * 100);
      console.log(`📈 Progresso: ${processedSoFar}/${products.length} (${progressPercent}%)`);
      
      // Delay tra batch per rate limiting
      if (currentBatch < totalBatches) {
        console.log(`⏸️ Pausa ${CONFIG.BATCH_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
      }
    }
  }

  // STRATEGIA MULTI-FONTE CON FALLBACK
  async fetchProductsMultiSource() {
    const results = { source: null, products: [], errors: [] };
    
    console.log('🎯 MODALITÀ HYBRID: CSV primario con JSON fallback');
    
    // Prova CSV prima (più affidabile)
    try {
      results.products = await this.fetchCSVProducts();
      results.source = 'CSV_PRIMARY';
      console.log(`✅ HYBRID: CSV primario riuscito - ${results.products.length} prodotti`);
      return results;
    } catch (error) {
      results.errors.push(`CSV: ${error.message}`);
      console.log('⚠️ HYBRID: CSV fallito, tentativo JSON fallback...');
    }
    
    // Fallback JSON
    try {
      results.products = await this.fetchJSONProducts();
      results.source = 'JSON_FALLBACK';
      console.log(`✅ HYBRID: JSON fallback riuscito - ${results.products.length} prodotti`);
      return results;
    } catch (error) {
      results.errors.push(`JSON: ${error.message}`);
    }
    
    throw new Error(`Tutte le fonti fallite: ${results.errors.join(' | ')}`);
  }

  // SINCRONIZZAZIONE PRINCIPALE
  async sync() {
    try {
      console.log('\n🚀 INIZIO SINCRONIZZAZIONE IBRIDA MSY → ECWID');
      console.log('=====================================================');
      
      this.resetStats();
      this.stats.startTime = Date.now();

      // Recupero prodotti con strategia ibrida
      const result = await this.fetchProductsMultiSource();
      this.stats.total = result.products.length;
      this.stats.source = result.source;

      console.log(`📊 Fonte dati: ${result.source}`);
      console.log(`📈 Prodotti totali: ${result.products.length}`);

      if (result.products.length === 0) {
        console.log('⚠️ Nessun prodotto trovato dalle fonti MSY');
        return this.generateReport();
      }

      // Processamento prodotti
      await this.processBatch(result.products);

      this.stats.endTime = Date.now();
      return this.generateReport();

    } catch (error) {
      console.error('❌ ERRORE SYNC PRINCIPALE:', error.message);
      this.stats.endTime = Date.now();
      throw error;
    }
  }

  // REPORT FINALE
  generateReport() {
    const duration = this.stats.endTime - this.stats.startTime;
    const durationSeconds = Math.round(duration / 1000);
    
    const report = {
      success: true,
      timestamp: new Date().toISOString(),
      duration: `${durationSeconds}s`,
      source: this.stats.source,
      stats: {
        total: this.stats.total,
        processed: this.stats.processed,
        created: this.stats.created,
        updated: this.stats.updated,
        ignored: this.stats.ignored,
        errors: this.stats.errors,
        reasons: this.stats.reasons
      },
      errorSKUs: this.errorSKUs.slice(0, 20), // Prime 20 errori
      performance: {
        productsPerSecond: durationSeconds > 0 ? Math.round(this.stats.processed / durationSeconds * 10) / 10 : 0,
        successRate: this.stats.total > 0 ? Math.round((this.stats.processed / this.stats.total) * 100) : 0
      }
    };

    console.log('\n📊 REPORT SINCRONIZZAZIONE IBRIDA');
    console.log('=====================================');
    console.log(`📊 Fonte: ${this.stats.source}`);
    console.log(`⏱️ Durata: ${durationSeconds}s`);
    console.log(`📈 Totale: ${this.stats.total}`);
    console.log(`✅ Processati: ${this.stats.processed}`);
    console.log(`🆕 Creati: ${this.stats.created}`);
    console.log(`📝 Aggiornati: ${this.stats.updated}`);
    console.log(`⏭️ Ignorati: ${this.stats.ignored} (${this.stats.reasons.lowPrice} prezzo basso, ${this.stats.reasons.noImages} senza immagini)`);
    console.log(`❌ Errori: ${this.stats.errors}`);
    console.log(`🎯 Tasso successo: ${report.performance.successRate}%`);
    console.log(`⚡ Velocità: ${report.performance.productsPerSecond} prodotti/secondo`);

    return report;
  }
}

// ===== ISTANZA GLOBALE =====
const syncService = new HybridMSYEcwidSync();

// ===== MIDDLEWARE EXPRESS =====
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ===== ROUTES API COMPLETE =====

// ROOT
app.get('/', (req, res) => {
  res.json({
    message: 'Hybrid MSY-Ecwid Sync API - VERSIONE COMPLETA',
    version: '2.0.0',
    endpoints: {
      health: 'GET /health - Health check sistema',
      sync: 'POST /sync - Sincronizzazione manuale completa', 
      stats: 'GET /stats - Statistiche dettagliate',
      testSources: 'GET /test-sources - Test connessioni MSY',
      config: 'GET /config - Visualizza configurazione'
    },
    timestamp: new Date().toISOString()
  });
});

// HEALTHCHECK POTENZIATO
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Hybrid MSY-Ecwid Sync',
    version: '2.0.0',
    mode: CONFIG.SYNC_MODE,
    config: {
      storeId: CONFIG.ECWID_STORE_ID,
      hasToken: !!CONFIG.ECWID_API_TOKEN,
      minPrice: CONFIG.MIN_PRICE_THRESHOLD,
      priceMultiplier: CONFIG.PRICE_MULTIPLIER,
      batchSize: CONFIG.BATCH_SIZE,
      requireImages: CONFIG.REQUIRE_IMAGES
    },
    uptime: process.uptime()
  });
});

// SINCRONIZZAZIONE COMPLETA
app.post('/sync', async (req, res) => {
  try {
    console.log('\n🔄 AVVIO SINCRONIZZAZIONE MANUALE...');
    const report = await syncService.sync();
    res.json(report);
  } catch (error) {
    console.error('❌ ERRORE SINCRONIZZAZIONE:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
      stats: syncService.stats
    });
  }
});

// STATISTICHE DETTAGLIATE
app.get('/stats', (req, res) => {
  res.json({
    currentStats: syncService.stats,
    errorCount: syncService.errorSKUs.length,
    recentErrors: syncService.errorSKUs.slice(-10),
    config: {
      mode: CONFIG.SYNC_MODE,
      storeId: CONFIG.ECWID_STORE_ID,
      batchSize: CONFIG.BATCH_SIZE,
      minPriceThreshold: CONFIG.MIN_PRICE_THRESHOLD,
      priceMultiplier: CONFIG.PRICE_MULTIPLIER,
      requireImages: CONFIG.REQUIRE_IMAGES,
      batchDelay: CONFIG.BATCH_DELAY
    },
    timestamp: new Date().toISOString()
  });
});

// TEST FONTI DATI MSY
app.get('/test-sources', async (req, res) => {
  const results = { 
    timestamp: new Date().toISOString(), 
    tests: {},
    summary: { accessible: 0, failed: 0 }
  };
  
  // Test CSV
  try {
    const csvResponse = await fetch(CONFIG.DATA_SOURCES.CSV_URL, { 
      method: 'HEAD', 
      timeout: 15000,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    results.tests.csv = {
      status: csvResponse.ok ? 'OK' : 'ERROR',
      statusCode: csvResponse.status,
      url: CONFIG.DATA_SOURCES.CSV_URL,
      contentType: csvResponse.headers.get('content-type'),
      contentLength: csvResponse.headers.get('content-length')
    };
    if (csvResponse.ok) results.summary.accessible++;
    else results.summary.failed++;
  } catch (error) {
    results.tests.csv = {
      status: 'ERROR',
      error: error.message,
      url: CONFIG.DATA_SOURCES.CSV_URL
    };
    results.summary.failed++;
  }
  
  // Test JSON
  try {
    const jsonResponse = await fetch(CONFIG.DATA_SOURCES.JSON_URL, { 
      method: 'HEAD', 
      timeout: 15000,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    results.tests.json = {
      status: jsonResponse.ok ? 'OK' : 'ERROR',
      statusCode: jsonResponse.status,
      url: CONFIG.DATA_SOURCES.JSON_URL,
      contentType: jsonResponse.headers.get('content-type'),
      contentLength: jsonResponse.headers.get('content-length')
    };
    if (jsonResponse.ok) results.summary.accessible++;
    else results.summary.failed++;
  } catch (error) {
    results.tests.json = {
      status: 'ERROR',
      error: error.message,
      url: CONFIG.DATA_SOURCES.JSON_URL
    };
    results.summary.failed++;
  }
  
  // Test token Ecwid
  try {
    if (CONFIG.ECWID_API_TOKEN) {
      const ecwidResponse = await fetch(`${CONFIG.ECWID_API_URL}/products?limit=1`, {
        headers: {
          'Authorization': `Bearer ${CONFIG.ECWID_API_TOKEN}`,
          'User-Agent': CONFIG.USER_AGENT
        },
        timeout: 10000
      });
      results.tests.ecwid = {
        status: ecwidResponse.ok ? 'OK' : 'ERROR',
        statusCode: ecwidResponse.status,
        url: CONFIG.ECWID_API_URL,
        hasValidToken: true
      };
      if (ecwidResponse.ok) results.summary.accessible++;
      else results.summary.failed++;
    } else {
      results.tests.ecwid = {
        status: 'ERROR',
        error: 'ECWID_API_TOKEN non configurato',
        hasValidToken: false
      };
      results.summary.failed++;
    }
  } catch (error) {
    results.tests.ecwid = {
      status: 'ERROR',
      error: error.message,
      hasValidToken: !!CONFIG.ECWID_API_TOKEN
    };
    results.summary.failed++;
  }
  
  res.json(results);
});

// CONFIGURAZIONE SISTEMA
app.get('/config', (req, res) => {
  res.json({
    version: '2.0.0',
    mode: CONFIG.SYNC_MODE,
    dataSources: CONFIG.DATA_SOURCES,
    ecwid: {
      storeId: CONFIG.ECWID_STORE_ID,
      hasToken: !!CONFIG.ECWID_API_TOKEN,
      apiUrl: CONFIG.ECWID_API_URL
    },
    validation: {
      requireImages: CONFIG.REQUIRE_IMAGES,
      minPriceThreshold: CONFIG.MIN_PRICE_THRESHOLD,
      priceMultiplier: CONFIG.PRICE_MULTIPLIER
    },
    performance: {
      batchSize: CONFIG.BATCH_SIZE,
      batchDelay: CONFIG.BATCH_DELAY,
      requestTimeout: CONFIG.REQUEST_TIMEOUT
    },
    timestamp: new Date().toISOString()
  });
});

// ===== CRON JOB AUTOMATICO =====
cron.schedule('0 6 * * *', async () => {
  try {
    console.log('\n⏰ SINCRONIZZAZIONE AUTOMATICA (6:00 AM)...');
    await syncService.sync();
  } catch (error) {
    console.error('❌ Errore sync automatica:', error.message);
  }
}, {
  timezone: "Europe/Rome"
});

// ===== GESTIONE ERRORI GLOBALI =====
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// ===== AVVIO SERVER =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 HYBRID MSY-ECWID SYNC SERVER v2.0 AVVIATO');
  console.log('===============================================');
  console.log(`🌐 Server: http://localhost:${PORT}`);
  console.log(`🎯 Modalità: ${CONFIG.SYNC_MODE}`);
  console.log(`🏪 Store Ecwid: ${CONFIG.ECWID_STORE_ID}`);
  console.log(`💰 Soglia prezzo: €${CONFIG.MIN_PRICE_THRESHOLD} (x${CONFIG.PRICE_MULTIPLIER})`);
  console.log(`📦 Batch size: ${CONFIG.BATCH_SIZE} prodotti`);
  console.log(`⏱️ Delay batch: ${CONFIG.BATCH_DELAY}ms`);
  console.log('');
  console.log('📋 API ENDPOINTS:');
  console.log('   GET  /health        - Health check dettagliato');
  console.log('   POST /sync          - Sincronizzazione completa');
  console.log('   GET  /stats         - Statistiche avanzate');
  console.log('   GET  /test-sources  - Test completo fonti dati');
  console.log('   GET  /config        - Configurazione sistema');
  console.log('');
  console.log('⏰ Sync automatica: ogni giorno alle 6:00 AM (timezone Europe/Rome)');
  console.log('✅ Sistema v2.0 pronto con parsing MSY corretto!');
});
