const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAZIONE =====
const CONFIG = {
  // FONTI DATI MSY
  DATA_SOURCES: {
    CSV_URL: 'https://msy.madtec.be/price_list/pricelist_en.csv',
    JSON_URL: 'http://msy.madtec.be/price_list/pricelist_en.json',
  },
  
  // MODALITÀ SYNC
  SYNC_MODE: 'HYBRID', // CSV prima, JSON fallback
  
  // ECWID CONFIG
  ECWID_STORE_ID: '29517085',
  ECWID_API_TOKEN: process.env.ECWID_API_TOKEN,
  ECWID_API_URL: `https://app.ecwid.com/api/v3/29517085`,
  
  // VALIDAZIONE
  REQUIRE_IMAGES: false,
  MIN_PRICE_THRESHOLD: 20,
  BATCH_SIZE: 10,
  BATCH_DELAY: 2000,
};

// ===== CLASSE SYNC IBRIDA =====
class HybridMSYEcwidSync {
  constructor() {
    this.stats = {
      total: 0, processed: 0, created: 0, updated: 0, ignored: 0, errors: 0,
      reasons: { noImages: 0, lowPrice: 0, invalidData: 0, apiError: 0 },
      source: null
    };
    this.errorSKUs = [];
  }

  // FETCH CSV
  async fetchCSVProducts() {
    try {
      console.log('📊 Recupero CSV...');
      const response = await fetch(CONFIG.DATA_SOURCES.CSV_URL, {
        timeout: 30000,
        headers: { 'User-Agent': 'MSY-Ecwid-Sync/1.0' }
      });
      
      if (!response.ok) {
        throw new Error(`CSV error: ${response.status}`);
      }
      
      const csvData = await response.text();
      const parsed = Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim().toLowerCase()
      });
      
      const products = this.normalizeCSVProducts(parsed.data);
      console.log(`✅ CSV: ${products.length} prodotti`);
      return products;
      
    } catch (error) {
      console.error('❌ Errore CSV:', error.message);
      throw error;
    }
  }

  // FETCH JSON
  async fetchJSONProducts() {
    try {
      console.log('🔄 Recupero JSON...');
      const response = await fetch(CONFIG.DATA_SOURCES.JSON_URL, {
        timeout: 30000,
        headers: { 'User-Agent': 'MSY-Ecwid-Sync/1.0', 'Accept': 'application/json' }
      });
      
      if (!response.ok) {
        throw new Error(`JSON error: ${response.status}`);
      }
      
      const data = await response.json();
      if (!data || !data.price_list || !Array.isArray(data.price_list)) {
        throw new Error('JSON structure invalid');
      }
      
      const products = this.normalizeJSONProducts(data.price_list);
      console.log(`✅ JSON: ${products.length} prodotti`);
      return products;
      
    } catch (error) {
      console.error('❌ Errore JSON:', error.message);
      throw error;
    }
  }

  // NORMALIZZAZIONE CSV
  normalizeCSVProducts(csvRows) {
    return csvRows
      .filter(row => row && (row.article_num || row.sku))
      .map(row => ({
        sku: (row.article_num || row.sku || '').toString().trim(),
        name: (row.name || `Prodotto ${row.article_num || row.sku}`).toString().trim(),
        price: this.parsePrice(row.price),
        stock: this.parseStock(row.stock),
        description: (row.description || '').toString().trim(),
        category: (row.cat || row.category || '').toString().trim(),
        brand: (row.brand || '').toString().trim(),
        images: this.extractImages(row)
      }))
      .filter(product => product.sku && product.sku.length > 0);
  }

  // NORMALIZZAZIONE JSON
  normalizeJSONProducts(jsonArray) {
    return jsonArray
      .filter(item => item && (item.article_num || item.sku))
      .map(item => ({
        sku: (item.article_num || item.sku || '').toString().trim(),
        name: (item.name || `Prodotto ${item.article_num || item.sku}`).toString().trim(),
        price: this.parsePrice(item.price),
        stock: this.parseStock(item.stock),
        description: (item.description || '').toString().trim(),
        category: (item.cat || item.category || '').toString().trim(),
        brand: (item.brand || '').toString().trim(),
        images: this.extractImages(item)
      }))
      .filter(product => product.sku && product.sku.length > 0);
  }

  // UTILITIES
  parsePrice(price) {
    if (price === null || price === undefined || price === '') return 0;
    const cleanPrice = String(price).replace(/[^\d.,]/g, '').replace(',', '.');
    const parsed = parseFloat(cleanPrice);
    return isNaN(parsed) ? 0 : Math.max(0, parsed);
  }

  parseStock(stock) {
    if (stock === null || stock === undefined || stock === '') return 0;
    const parsed = parseInt(String(stock).replace(/[^\d]/g, ''));
    return isNaN(parsed) ? 0 : Math.max(0, parsed);
  }

  extractImages(item) {
    const imageFields = ['photo_1', 'photo_2', 'photo_3', 'photo_4', 'photo_5', 'image1_url', 'image2_url'];
    const images = [];
    
    for (const field of imageFields) {
      if (item[field]) {
        const url = String(item[field]).trim();
        if (url && url !== '' && url.startsWith('http')) {
          images.push(url);
        }
      }
    }
    return images;
  }

  // STRATEGIA MULTI-FONTE
  async fetchProductsMultiSource() {
    const results = { source: null, products: [], errors: [] };
    
    // MODALITÀ HYBRID - CSV prima (più stabile)
    console.log('🎯 MODALITÀ HYBRID: CSV prima, JSON fallback');
    
    // Prova CSV prima
    try {
      results.products = await this.fetchCSVProducts();
      results.source = 'CSV_PRIMARY';
      console.log('✅ HYBRID: CSV primario riuscito!');
      return results;
    } catch (error) {
      results.errors.push(`CSV: ${error.message}`);
      console.log('⚠️ HYBRID: CSV fallito, provo JSON fallback...');
    }
    
    // Fallback a JSON
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

  // CALCOLO PREZZO RADDOPPIATO
  calculatePrice(originalPrice) {
    const price = parseFloat(originalPrice);
    if (isNaN(price) || price <= 0) return false;
    return Math.round(price * 2 * 100) / 100;
  }

  // VALIDAZIONE PRODOTTO
  validateProduct(product) {
    const validImages = product.images || [];
    
    if (CONFIG.REQUIRE_IMAGES && validImages.length === 0) {
      this.stats.reasons.noImages++;
      return { valid: false, reason: 'NO_IMAGES' };
    }

    const finalPrice = this.calculatePrice(product.price);
    if (!finalPrice) {
      this.stats.reasons.invalidData++;
      return { valid: false, reason: 'INVALID_PRICE' };
    }

    if (finalPrice < CONFIG.MIN_PRICE_THRESHOLD) {
      this.stats.reasons.lowPrice++;
      return { valid: false, reason: 'PRICE_TOO_LOW' };
    }
    
    // Validazione stock
    if (product.stock !== undefined && product.stock !== null) {
      if (typeof product.stock !== 'number' || isNaN(product.stock) || product.stock < 0) {
        product.stock = 0;
      } else {
        product.stock = Math.floor(product.stock);
      }
    } else {
      product.stock = 0;
    }
    
    return { valid: true, price: finalPrice, images: validImages };
  }

  // RICERCA PRODOTTO ECWID
  async searchEcwidProduct(sku) {
    try {
      const url = `${CONFIG.ECWID_API_URL}/products?sku=${encodeURIComponent(sku)}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${CONFIG.ECWID_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      if (!response.ok) {
        throw new Error(`Ecwid search error: ${response.status}`);
      }

      const data = await response.json();
      return data.items && data.items.length > 0 ? data.items[0] : null;

    } catch (error) {
      console.error(`❌ Errore ricerca ${sku}:`, error.message);
      return null;
    }
  }

  // CREAZIONE/AGGIORNAMENTO ECWID
  async upsertEcwidProduct(product, validation, existingProduct = null) {
    try {
      const productData = {
        name: product.name,
        sku: product.sku,
        price: validation.price,
        quantity: product.stock,
        description: product.description || '',
        enabled: true,
        categories: product.category ? [{ name: product.category }] : []
      };

      if (validation.images.length > 0) {
        productData.media = {
          images: validation.images.map(url => ({ url }))
        };
      }

      let url, method;
      
      if (existingProduct) {
        url = `${CONFIG.ECWID_API_URL}/products/${existingProduct.id}`;
        method = 'PUT';
        this.stats.updated++;
      } else {
        url = `${CONFIG.ECWID_API_URL}/products`;
        method = 'POST';
        this.stats.created++;
      }

      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${CONFIG.ECWID_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(productData),
        timeout: 15000
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ecwid ${method} error: ${response.status} - ${errorText}`);
      }

      return await response.json();

    } catch (error) {
      this.stats.errors++;
      this.errorSKUs.push({
        sku: product.sku,
        step: existingProduct ? 'update' : 'create',
        error: error.message
      });
      throw error;
    }
  }

  // PROCESSAMENTO SINGOLO PRODOTTO
  async processProduct(product) {
    try {
      const validation = this.validateProduct(product);
      if (!validation.valid) {
        console.log(`⚠️ ${product.sku}: ${validation.reason}`);
        this.stats.ignored++;
        return;
      }

      const existingProduct = await this.searchEcwidProduct(product.sku);
      const action = existingProduct ? 'aggiornamento' : 'creazione';
      
      await this.upsertEcwidProduct(product, validation, existingProduct);
      
      console.log(`✅ ${product.sku}: ${action} completato`);
      this.stats.processed++;

    } catch (error) {
      this.stats.errors++;
    }
  }

  // PROCESSAMENTO BATCH
  async processBatch(products) {
    const batches = [];
    for (let i = 0; i < products.length; i += CONFIG.BATCH_SIZE) {
      batches.push(products.slice(i, i + CONFIG.BATCH_SIZE));
    }

    console.log(`📦 ${products.length} prodotti in ${batches.length} batch`);

    for (let i = 0; i < batches.length; i++) {
      console.log(`🚀 BATCH ${i + 1}/${batches.length}`);
      
      const batch = batches[i];
      await Promise.all(batch.map(product => this.processProduct(product)));
      
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
      }
    }
  }

  // SYNC PRINCIPALE
  async sync() {
    try {
      console.log('\n🚀 INIZIO SYNC IBRIDA MSY → ECWID');
      
      const startTime = Date.now();
      this.resetStats();

      const result = await this.fetchProductsMultiSource();
      this.stats.total = result.products.length;
      this.stats.source = result.source;

      console.log(`📊 Fonte: ${result.source}`);
      console.log(`📈 Prodotti: ${result.products.length}`);

      if (result.products.length === 0) {
        console.log('⚠️ Nessun prodotto trovato');
        return this.generateReport(Date.now() - startTime);
      }

      await this.processBatch(result.products);

      const duration = Date.now() - startTime;
      return this.generateReport(duration);

    } catch (error) {
      console.error('❌ ERRORE SYNC:', error.message);
      throw error;
    }
  }

  resetStats() {
    this.stats = {
      total: 0, processed: 0, created: 0, updated: 0, ignored: 0, errors: 0,
      reasons: { noImages: 0, lowPrice: 0, invalidData: 0, apiError: 0 },
      source: null
    };
    this.errorSKUs = [];
  }

  generateReport(duration) {
    const report = {
      success: true,
      timestamp: new Date().toISOString(),
      duration: `${Math.round(duration / 1000)}s`,
      stats: this.stats,
      errorSKUs: this.errorSKUs.slice(0, 10)
    };

    console.log('\n📊 REPORT SYNC IBRIDA');
    console.log(`📊 Fonte: ${this.stats.source}`);
    console.log(`⏱️ Durata: ${report.duration}`);
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
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ===== ROUTES API =====

// HEALTHCHECK (OBBLIGATORIO PER RAILWAY)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Hybrid MSY-Ecwid Sync',
    version: '1.0.0',
    mode: CONFIG.SYNC_MODE
  });
});

// ROOT
app.get('/', (req, res) => {
  res.json({
    message: 'Hybrid MSY-Ecwid Sync API',
    endpoints: ['/health', '/sync', '/stats', '/test-sources'],
    timestamp: new Date().toISOString()
  });
});

// SINCRONIZZAZIONE MANUALE
app.post('/sync', async (req, res) => {
  try {
    console.log('\n🔄 AVVIO SYNC MANUALE...');
    const report = await syncService.sync();
    res.json(report);
  } catch (error) {
    console.error('❌ ERRORE SYNC:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// STATISTICHE
app.get('/stats', (req, res) => {
  res.json({
    currentStats: syncService.stats,
    errorCount: syncService.errorSKUs.length,
    config: {
      mode: CONFIG.SYNC_MODE,
      batchSize: CONFIG.BATCH_SIZE,
      minPriceThreshold: CONFIG.MIN_PRICE_THRESHOLD
    },
    timestamp: new Date().toISOString()
  });
});

// TEST FONTI DATI
app.get('/test-sources', async (req, res) => {
  const results = { timestamp: new Date().toISOString(), tests: {} };
  
  // Test CSV
  try {
    const csvResponse = await fetch(CONFIG.DATA_SOURCES.CSV_URL, { 
      method: 'HEAD', timeout: 10000 
    });
    results.tests.csv = {
      status: csvResponse.ok ? 'OK' : 'ERROR',
      statusCode: csvResponse.status,
      url: CONFIG.DATA_SOURCES.CSV_URL
    };
  } catch (error) {
    results.tests.csv = {
      status: 'ERROR',
      error: error.message,
      url: CONFIG.DATA_SOURCES.CSV_URL
    };
  }
  
  // Test JSON
  try {
    const jsonResponse = await fetch(CONFIG.DATA_SOURCES.JSON_URL, { 
      method: 'HEAD', timeout: 10000 
    });
    results.tests.json = {
      status: jsonResponse.ok ? 'OK' : 'ERROR',
      statusCode: jsonResponse.status,
      url: CONFIG.DATA_SOURCES.JSON_URL
    };
  } catch (error) {
    results.tests.json = {
      status: 'ERROR',
      error: error.message,
      url: CONFIG.DATA_SOURCES.JSON_URL
    };
  }
  
  res.json(results);
});

// ===== CRON JOB =====
cron.schedule('0 6 * * *', async () => {
  try {
    console.log('\n⏰ SYNC PROGRAMMATA (6:00 AM)...');
    await syncService.sync();
  } catch (error) {
    console.error('❌ Errore sync programmata:', error.message);
  }
}, {
  timezone: "Europe/Rome"
});

// ===== GESTIONE ERRORI =====
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// ===== AVVIO SERVER =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 HYBRID MSY-ECWID SYNC SERVER AVVIATO');
  console.log('=========================================');
  console.log(`🌐 Server: http://localhost:${PORT}`);
  console.log(`🎯 Modalità: ${CONFIG.SYNC_MODE}`);
  console.log('');
  console.log('📋 API ENDPOINTS:');
  console.log('   GET  /health        - Health check');
  console.log('   POST /sync          - Sincronizzazione manuale');
  console.log('   GET  /stats         - Statistiche attuali');
  console.log('   GET  /test-sources  - Test fonti dati');
  console.log('');
  console.log('⏰ Sync automatica: ogni giorno alle 6:00 AM');
  console.log('✅ Sistema pronto!');
});
