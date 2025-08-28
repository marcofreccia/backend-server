const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAZIONE COMPLETA =====
const CONFIG = {
  DATA_SOURCES: {
    CSV_URL: 'https://msy.madtec.be/price_list/pricelist_en.csv',
    JSON_URL: 'http://msy.madtec.be/price_list/pricelist_en.json'
  },
  
  SYNC_MODE: 'HYBRID',
  ECWID_STORE_ID: process.env.ECWID_STORE_ID || '29517085',
  ECWID_API_TOKEN: process.env.ECWID_API_TOKEN,
  ECWID_API_URL: `https://app.ecwid.com/api/v3/${process.env.ECWID_STORE_ID || '29517085'}`,
  
  // PARAMETRI OTTIMIZZATI PER PRESTAZIONI
  REQUIRE_IMAGES: false,
  MIN_PRICE_THRESHOLD: 15,
  PRICE_MULTIPLIER: 2,
  BATCH_SIZE: 3,                    // Ridotto per evitare rate limiting
  BATCH_DELAY: 3000,                // Delay ottimizzato
  REQUEST_TIMEOUT: 30000,           // Timeout ridotto
  USER_AGENT: 'MSY-Ecwid-Sync/2.1'
};

// ===== UTILITY FUNCTIONS =====
function parsePrice(price) {
  if (!price || price === null || price === undefined || price === '') return 0;
  const cleanPrice = String(price).replace(/[^\d.,-]/g, '').replace(',', '.');
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

// ===== CLASSE SYNC ASINCRONA =====
class HybridMSYEcwidSync {
  constructor() {
    this.resetStats();
    this.isRunning = false;           // Flag per processo in corso
    this.lastReport = null;           // Ultimo report di sincronizzazione
    this.lastError = null;            // Ultimo errore
    this.lastSyncTime = null;         // Timestamp ultima sync
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
      console.log(`📊 CSV dimensione: ${Math.round(csvData.length / 1024)}KB`);
      
      // PARSING SPECIFICO PER FORMATO MSY
      const parsed = Papa.parse(csvData, {
        header: true,
        delimiter: ';',
        skipEmptyLines: true,
        transformHeader: function(header) {
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
      
      const validProducts = parsed.data.filter(function(row) {
        return row && row.article_num && row.article_num.trim() !== '' &&
               row.price && row.price.trim() !== '' &&
               row.name && row.name.trim() !== '';
      });
      
      console.log(`✅ CSV: ${validProducts.length} prodotti validi`);
      if (validProducts.length > 0) {
        console.log(`📝 Primo prodotto: ${validProducts[0].article_num} - ${validProducts[0].name}`);
      }
      
      return validProducts;
      
    } catch (error) {
      console.error('❌ Errore CSV:', error.message);
      throw error;
    }
  }

  // FETCH JSON FALLBACK
  async fetchJSONProducts() {
    try {
      console.log('🔄 Recupero JSON MSY...');
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
        throw new Error('JSON structure invalid');
      }
      
      console.log(`✅ JSON: ${data.price_list.length} prodotti`);
      return data.price_list;
      
    } catch (error) {
      console.error('❌ Errore JSON:', error.message);
      throw error;
    }
  }

  // STRATEGIA MULTI-FONTE
  async fetchProductsMultiSource() {
    const results = { source: null, products: [], errors: [] };
    
    console.log('🎯 MODALITÀ HYBRID: CSV prima, JSON fallback');
    
    // Prova CSV prima
    try {
      results.products = await this.fetchCSVProducts();
      results.source = 'CSV_PRIMARY';
      console.log('✅ HYBRID: CSV primario riuscito!');
      return results;
    } catch (error) {
      results.errors.push(`CSV: ${error.message}`);
      console.log('⚠️ HYBRID: CSV fallito, tentativo JSON...');
    }
    
    // Fallback JSON
    try {
      results.products = await this.fetchJSONProducts();
      results.source = 'JSON_FALLBACK';
      console.log('✅ HYBRID: JSON fallback riuscito!');
      return results;
    } catch (error) {
      results.errors.push(`JSON: ${error.message}`);
    }
    
    throw new Error(`Tutte le fonti fallite: ${results.errors.join(' | ')}`);
  }

  // NORMALIZZAZIONE PRODOTTO
  normalizeProduct(product) {
    try {
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
      
      if (finalPrice < CONFIG.MIN_PRICE_THRESHOLD) {
        this.stats.reasons.lowPrice++;
        return null;
      }

      const images = extractImages(product);
      
      if (CONFIG.REQUIRE_IMAGES && images.length === 0) {
        this.stats.reasons.noImages++;
        return null;
      }

      const stockQuantity = parseStock(product.stock);

      return {
        sku: product.article_num.trim(),
        name: product.name.trim(),
        description: (product.description || '').trim(),
        price: Math.round(finalPrice * 100) / 100,
        quantity: stockQuantity,
        brand: (product.brand || '').trim(),
        category: (product.main_category || '').trim(),
        images: images,
        originalPrice: originalPrice
      };
      
    } catch (error) {
      console.error(`❌ Errore normalizzazione ${product.article_num}:`, error.message);
      this.stats.reasons.invalidData++;
      return null;
    }
  }

  // RICERCA PRODOTTO ESISTENTE ECWID
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
          throw new Error('Token Ecwid non autorizzato');
        }
        throw new Error(`Ecwid search error: ${response.status}`);
      }

      const data = await response.json();
      return data.items && data.items.length > 0 ? data.items[0] : null;

    } catch (error) {
      console.error(`❌ Errore ricerca ${sku}:`, error.message);
      this.stats.reasons.apiError++;
      return null;
    }
  }

  // CREAZIONE/AGGIORNAMENTO PRODOTTO ECWID
  async upsertEcwidProduct(normalizedProduct, existingProduct) {
    try {
      const productData = {
        name: normalizedProduct.name,
        sku: normalizedProduct.sku,
        price: normalizedProduct.price,
        quantity: normalizedProduct.quantity,
        description: normalizedProduct.description,
        enabled: true
      };

      if (normalizedProduct.category) {
        productData.categories = [{ name: normalizedProduct.category }];
      }

      if (normalizedProduct.images && normalizedProduct.images.length > 0) {
        productData.media = {
          images: normalizedProduct.images.slice(0, 5).map(function(url) {
            return { url: url };
          })
        };
      }

      let url, method;
      
      if (existingProduct) {
        url = `${CONFIG.ECWID_API_URL}/products/${existingProduct.id}`;
        method = 'PUT';
      } else {
        url = `${CONFIG.ECWID_API_URL}/products`;
        method = 'POST';
      }

      const response = await fetch(url, {
        method: method,
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
      this.stats.errors++;
    }
  }

  // PROCESSAMENTO BATCH CON RATE LIMITING
  async processBatch(products) {
    const totalBatches = Math.ceil(products.length / CONFIG.BATCH_SIZE);
    
    console.log(`📦 Processamento in ${totalBatches} batch di ${CONFIG.BATCH_SIZE} prodotti`);

    for (let i = 0; i < products.length; i += CONFIG.BATCH_SIZE) {
      const currentBatch = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
      const batch = products.slice(i, i + CONFIG.BATCH_SIZE);
      
      console.log(`🚀 BATCH ${currentBatch}/${totalBatches}`);
      
      const self = this;
      await Promise.all(batch.map(function(product) {
        return self.processProduct(product);
      }));
      
      const processedSoFar = Math.min(i + CONFIG.BATCH_SIZE, products.length);
      const progressPercent = Math.round((processedSoFar / products.length) * 100);
      console.log(`📈 Progresso: ${processedSoFar}/${products.length} (${progressPercent}%)`);
      
      if (currentBatch < totalBatches) {
        console.log(`⏸️ Pausa ${CONFIG.BATCH_DELAY}ms...`);
        await new Promise(function(resolve) {
          setTimeout(resolve, CONFIG.BATCH_DELAY);
        });
      }
    }
  }

  // SINCRONIZZAZIONE PRINCIPALE
  async sync() {
    try {
      console.log('\n🚀 INIZIO SINCRONIZZAZIONE MSY → ECWID');
      console.log('==========================================');
      
      this.resetStats();
      this.stats.startTime = Date.now();

      const result = await this.fetchProductsMultiSource();
      this.stats.total = result.products.length;
      this.stats.source = result.source;

      console.log(`📊 Fonte: ${result.source}`);
      console.log(`📈 Prodotti: ${result.products.length}`);

      if (result.products.length === 0) {
        console.log('⚠️ Nessun prodotto trovato');
        this.stats.endTime = Date.now();
        return this.generateReport();
      }

      await this.processBatch(result.products);

      this.stats.endTime = Date.now();
      const report = this.generateReport();
      
      // Salva report per endpoint /sync-status
      this.lastReport = report;
      this.lastSyncTime = new Date().toISOString();
      
      return report;

    } catch (error) {
      console.error('❌ ERRORE SYNC:', error.message);
      this.stats.endTime = Date.now();
      this.lastError = error.message;
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
      errorSKUs: this.errorSKUs.slice(0, 10),
      performance: {
        productsPerSecond: durationSeconds > 0 ? Math.round(this.stats.processed / durationSeconds * 10) / 10 : 0,
        successRate: this.stats.total > 0 ? Math.round((this.stats.processed / this.stats.total) * 100) : 0
      }
    };

    console.log('\n📊 REPORT SINCRONIZZAZIONE');
    console.log('===========================');
    console.log(`📊 Fonte: ${this.stats.source}`);
    console.log(`⏱️ Durata: ${durationSeconds}s`);
    console.log(`📈 Totale: ${this.stats.total}`);
    console.log(`✅ Processati: ${this.stats.processed}`);
    console.log(`🆕 Creati: ${this.stats.created}`);
    console.log(`📝 Aggiornati: ${this.stats.updated}`);
    console.log(`⏭️ Ignorati: ${this.stats.ignored}`);
    console.log(`❌ Errori: ${this.stats.errors}`);

    return report;
  }
}

// ===== ISTANZA GLOBALE =====
const syncService = new HybridMSYEcwidSync();

// ===== MIDDLEWARE EXPRESS =====
app.use(express.json());
app.use(function(req, res, next) {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ===== ROUTES API COMPLETE =====

// HEALTHCHECK
app.get('/health', function(req, res) {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Hybrid MSY-Ecwid Sync',
    version: '2.1.0',
    mode: CONFIG.SYNC_MODE,
    config: {
      storeId: CONFIG.ECWID_STORE_ID,
      hasToken: !!CONFIG.ECWID_API_TOKEN,
      minPrice: CONFIG.MIN_PRICE_THRESHOLD,
      priceMultiplier: CONFIG.PRICE_MULTIPLIER,
      batchSize: CONFIG.BATCH_SIZE,
      async: true
    }
  });
});

// ROOT
app.get('/', function(req, res) {
  res.json({
    message: 'Hybrid MSY-Ecwid Sync API v2.1 - ASYNCHRONOUS',
    endpoints: {
      health: 'GET /health - Health check sistema',
      sync: 'POST /sync - Avvia sincronizzazione asincrona', 
      syncStatus: 'GET /sync-status - Stato sincronizzazione',
      stats: 'GET /stats - Statistiche dettagliate',
      testSources: 'GET /test-sources - Test connessioni MSY',
      config: 'GET /config - Visualizza configurazione'
    },
    timestamp: new Date().toISOString()
  });
});

// SINCRONIZZAZIONE ASINCRONA (RISOLVE ERROR 524)
app.post('/sync', function(req, res) {
  // Controlla se sync già in corso
  if (syncService.isRunning) {
    return res.status(429).json({
      success: false,
      message: "Sincronizzazione già in corso",
      status: "running",
      timestamp: new Date().toISOString(),
      checkStatus: "GET /sync-status per monitorare progresso"
    });
  }
  
  // RISPOSTA IMMEDIATA (< 1 secondo) - RISOLVE ERROR 524
  res.json({
    success: true,
    message: "Sincronizzazione avviata in background",
    timestamp: new Date().toISOString(),
    statusUrl: "/sync-status",
    estimatedDuration: "2-5 minuti",
    note: "Monitora con GET /sync-status per progresso"
  });
  
  // AVVIA SYNC IN BACKGROUND (NON BLOCCA HTTP)
  syncService.isRunning = true;
  syncService.lastError = null;
  
  setImmediate(async function() {
    try {
      console.log('🚀 Sync MSY→Ecwid avviata in background...');
      const report = await syncService.sync();
      console.log('✅ Sync completata con successo:', report.stats);
    } catch (error) {
      console.error('❌ Errore sync background:', error.message);
      syncService.lastError = error.message;
    } finally {
      syncService.isRunning = false;
    }
  });
});

// STATUS DELLA SINCRONIZZAZIONE IN TEMPO REALE
app.get('/sync-status', function(req, res) {
  const currentTime = new Date().toISOString();
  
  res.json({
    isRunning: syncService.isRunning || false,
    status: syncService.isRunning ? 'running' : 'idle',
    lastSyncTime: syncService.lastSyncTime,
    lastReport: syncService.lastReport,
    lastError: syncService.lastError,
    currentStats: syncService.stats,
    progress: syncService.stats.total > 0 ? 
      Math.round((syncService.stats.processed / syncService.stats.total) * 100) : 0,
    timestamp: currentTime
  });
});

// STATISTICHE DETTAGLIATE
app.get('/stats', function(req, res) {
  res.json({
    currentStats: syncService.stats,
    isRunning: syncService.isRunning || false,
    errorCount: syncService.errorSKUs.length,
    recentErrors: syncService.errorSKUs.slice(-5),
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

// TEST FONTI DATI MSY E ECWID
app.get('/test-sources', async function(req, res) {
  const results = { 
    timestamp: new Date().toISOString(), 
    tests: {},
    summary: { accessible: 0, failed: 0 }
  };
  
  // Test CSV
  try {
    const csvResponse = await fetch(CONFIG.DATA_SOURCES.CSV_URL, { 
      method: 'HEAD', 
      timeout: 10000,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    results.tests.csv = {
      status: csvResponse.ok ? 'OK' : 'ERROR',
      statusCode: csvResponse.status,
      url: CONFIG.DATA_SOURCES.CSV_URL,
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
      timeout: 10000,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    results.tests.json = {
      status: jsonResponse.ok ? 'OK' : 'ERROR',
      statusCode: jsonResponse.status,
      url: CONFIG.DATA_SOURCES.JSON_URL
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
app.get('/config', function(req, res) {
  res.json({
    version: '2.1.0',
    mode: CONFIG.SYNC_MODE,
    async: true,
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
cron.schedule('0 6 * * *', async function() {
  if (!syncService.isRunning) {
    try {
      console.log('\n⏰ SINCRONIZZAZIONE AUTOMATICA (6:00 AM)...');
      syncService.isRunning = true;
      await syncService.sync();
    } catch (error) {
      console.error('❌ Errore sync automatica:', error.message);
    } finally {
      syncService.isRunning = false;
    }
  }
}, {
  timezone: "Europe/Rome"
});

// ===== GESTIONE ERRORI GLOBALI =====
process.on('unhandledRejection', function(reason, promise) {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', function(error) {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// ===== AVVIO SERVER =====
app.listen(PORT, '0.0.0.0', function() {
  console.log('\n🚀 MSY-ECWID SYNC SERVER v2.1 AVVIATO');
  console.log('===============================================');
  console.log(`🌐 Server: http://localhost:${PORT}`);
  console.log(`🎯 Modalità: ${CONFIG.SYNC_MODE} (ASYNCHRONOUS)`);
  console.log(`🏪 Store Ecwid: ${CONFIG.ECWID_STORE_ID}`);
  console.log(`💰 Prezzi: MSY × ${CONFIG.PRICE_MULTIPLIER} (min €${CONFIG.MIN_PRICE_THRESHOLD})`);
  console.log(`📦 Batch: ${CONFIG.BATCH_SIZE} prodotti ogni ${CONFIG.BATCH_DELAY}ms`);
  console.log('');
  console.log('📋 API ENDPOINTS:');
  console.log('   GET  /health        - Health check dettagliato');
  console.log('   POST /sync          - ⚡ Avvia sync ASINCRONO');
  console.log('   GET  /sync-status   - 📊 Monitora progresso sync');
  console.log('   GET  /stats         - 📈 Statistiche complete');
  console.log('   GET  /test-sources  - 🔍 Test fonti MSY + Ecwid');
  console.log('   GET  /config        - ⚙️ Configurazione sistema');
  console.log('');
  console.log('⏰ Sync automatica: ogni giorno alle 6:00 AM');
  console.log('🛡️ Protezione Error 524: SYNC ASINCRONO ATTIVO');
  console.log('✅ Sistema v2.1 pronto per sincronizzazione!');
});
