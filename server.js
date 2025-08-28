 const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAZIONE IBRIDA =====
const CONFIG = {
  // FONTI DATI MSY (ORDINE PRIORITÀ)
  DATA_SOURCES: {
    CSV_URL: 'https://msy.madtec.be/price_list/pricelist_en.csv',
    JSON_URL: 'http://msy.madtec.be/price_list/pricelist_en.json',
  },
  
  // MODALITÀ SYNC
  SYNC_MODE: 'HYBRID', // 'CSV_ONLY', 'JSON_ONLY', 'HYBRID'
  
  // ECWID CONFIG
  ECWID_STORE_ID: '329517085',
  ECWID_API_TOKEN: process.env.ECWID_API_TOKEN,
  ECWID_API_URL: `https://app.ecwid.com/api/v3/329517085`,
  
  // VALIDAZIONE
  REQUIRE_IMAGES: false,
  MIN_PRICE_THRESHOLD: 20,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  BATCH_SIZE: 10,
  BATCH_DELAY: 2000,
};

// ===== CLASSE IBRIDA MSY-ECWID SYNC =====
class HybridMSYEcwidSync {
  constructor() {
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
      source: null
    };
    this.errorSKUs = [];
  }

  // ===== FETCH CSV PRODOTTI =====
  async fetchCSVProducts() {
    try {
      console.log('📊 Recupero dati da CSV MSY...');
      const response = await fetch(CONFIG.DATA_SOURCES.CSV_URL, {
        timeout: 30000,
        headers: {
          'User-Agent': 'MSY-Ecwid-Sync/1.0'
        }
      });
      
      if (!response.ok) {
        throw new Error(`CSV HTTP error: ${response.status} ${response.statusText}`);
      }
      
      const csvData = await response.text();
      
      if (!csvData || csvData.trim().length === 0) {
        throw new Error('CSV vuoto o non valido');
      }
      
      const parsed = Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim().toLowerCase(),
        delimiter: ',',
        quoteChar: '"'
      });
      
      if (parsed.errors && parsed.errors.length > 0) {
        console.warn('⚠️ CSV parsing warnings:', parsed.errors.slice(0, 5));
      }
      
      const products = this.normalizeCSVProducts(parsed.data);
      console.log(`✅ CSV: ${products.length} prodotti recuperati e normalizzati`);
      return products;
      
    } catch (error) {
      console.error('❌ Errore fetch CSV:', error.message);
      throw error;
    }
  }

  // ===== FETCH JSON PRODOTTI =====
  async fetchJSONProducts() {
    try {
      console.log('🔄 Recupero dati da JSON MSY...');
      const response = await fetch(CONFIG.DATA_SOURCES.JSON_URL, {
        timeout: 30000,
        headers: {
          'User-Agent': 'MSY-Ecwid-Sync/1.0',
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`JSON HTTP error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data || !data.price_list || !Array.isArray(data.price_list)) {
        throw new Error('JSON structure invalid: missing price_list array');
      }
      
      const products = this.normalizeJSONProducts(data.price_list);
      console.log(`✅ JSON: ${products.length} prodotti recuperati e normalizzati`);
      return products;
      
    } catch (error) {
      console.error('❌ Errore fetch JSON:', error.message);
      throw error;
    }
  }

  // ===== NORMALIZZAZIONE CSV =====
  normalizeCSVProducts(csvRows) {
    if (!Array.isArray(csvRows)) {
      throw new Error('CSV data is not an array');
    }

    return csvRows
      .filter(row => row && (row.article_num || row.sku))
      .map(row => {
        try {
          return {
            sku: (row.article_num || row.sku || '').toString().trim(),
            name: (row.name || `Prodotto ${row.article_num || row.sku}`).toString().trim(),
            price: this.parsePrice(row.price),
            stock: this.parseStock(row.stock),
            description: (row.description || '').toString().trim(),
            category: (row.cat || row.category || '').toString().trim(),
            brand: (row.brand || '').toString().trim(),
            images: this.extractImages(row)
          };
        } catch (error) {
          console.warn(`⚠️ Errore normalizzazione riga CSV:`, error.message);
          return null;
        }
      })
      .filter(product => product && product.sku && product.sku.length > 0);
  }

  // ===== NORMALIZZAZIONE JSON =====
  normalizeJSONProducts(jsonArray) {
    if (!Array.isArray(jsonArray)) {
      throw new Error('JSON data is not an array');
    }

    return jsonArray
      .filter(item => item && (item.article_num || item.sku))
      .map(item => {
        try {
          return {
            sku: (item.article_num || item.sku || '').toString().trim(),
            name: (item.name || `Prodotto ${item.article_num || item.sku}`).toString().trim(),
            price: this.parsePrice(item.price),
            stock: this.parseStock(item.stock),
            description: (item.description || '').toString().trim(),
            category: (item.cat || item.category || '').toString().trim(),
            brand: (item.brand || '').toString().trim(),
            images: this.extractImages(item)
          };
        } catch (error) {
          console.warn(`⚠️ Errore normalizzazione item JSON:`, error.message);
          return null;
        }
      })
      .filter(product => product && product.sku && product.sku.length > 0);
  }

  // ===== PARSING UTILITIES =====
  parsePrice(price) {
    if (price === null || price === undefined || price === '') return 0;
    
    const cleanPrice = String(price)
      .replace(/[^\d.,]/g, '')
      .replace(',', '.');
    
    const parsed = parseFloat(cleanPrice);
    return isNaN(parsed) ? 0 : Math.max(0, parsed);
  }

  parseStock(stock) {
    if (stock === null || stock === undefined || stock === '') return 0;
    
    const parsed = parseInt(String(stock).replace(/[^\d]/g, ''));
    return isNaN(parsed) ? 0 : Math.max(0, parsed);
  }

  extractImages(item) {
    const imageFields = [
      'photo_1', 'photo_2', 'photo_3', 'photo_4', 'photo_5',
      'image1_url', 'image2_url', 'image3_url', 'main_image', 'image_url'
    ];
    
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

  // ===== STRATEGIA MULTI-FONTE =====
  async fetchProductsMultiSource() {
    const results = { source: null, products: [], errors: [] };
    
    // CSV_ONLY mode
    if (CONFIG.SYNC_MODE === 'CSV_ONLY') {
      try {
        results.products = await this.fetchCSVProducts();
        results.source = 'CSV_ONLY';
        return results;
      } catch (error) {
        results.errors.push(`CSV: ${error.message}`);
        throw new Error(`CSV_ONLY mode failed: ${error.message}`);
      }
    }
    
    // JSON_ONLY mode
    if (CONFIG.SYNC_MODE === 'JSON_ONLY') {
      try {
        results.products = await this.fetchJSONProducts();
        results.source = 'JSON_ONLY';
        return results;
      } catch (error) {
        results.errors.push(`JSON: ${error.message}`);
        throw new Error(`JSON_ONLY mode failed: ${error.message}`);
      }
    }
    
    // HYBRID mode - CSV primary, JSON fallback
    if (CONFIG.SYNC_MODE === 'HYBRID') {
      console.log('🎯 MODALITÀ HYBRID: CSV prima, JSON fallback');
      
      // Try CSV first (more stable)
      try {
        results.products = await this.fetchCSVProducts();
        results.source = 'CSV_PRIMARY';
        console.log('✅ HYBRID: CSV primario riuscito!');
        return results;
      } catch (error) {
        results.errors.push(`CSV Primary: ${error.message}`);
        console.log('⚠️ HYBRID: CSV fallito, tentativo JSON fallback...');
      }
      
      // Fallback to JSON
      try {
        results.products = await this.fetchJSONProducts();
        results.source = 'JSON_FALLBACK';
        console.log('✅ HYBRID: JSON fallback riuscito!');
        return results;
      } catch (error) {
        results.errors.push(`JSON Fallback: ${error.message}`);
        console.log('❌ HYBRID: Anche JSON fallback fallito!');
      }
    }
    
    throw new Error(`Tutte le fonti dati fallite: ${results.errors.join(' | ')}`);
  }

  // ===== CALCOLO PREZZO RADDOPPIATO =====
  calculatePrice(originalPrice) {
    const price = parseFloat(originalPrice);
    if (isNaN(price) || price <= 0) return false;
    
    // Raddoppia il prezzo e arrotonda a 2 decimali
    return Math.round(price * 2 * 100) / 100;
  }

  // ===== VALIDAZIONE PRODOTTO COMPLETA =====
  validateProduct(product) {
    // 1. Controllo immagini (opzionale)
    const validImages = product.images || [];
    
    if (CONFIG.REQUIRE_IMAGES && validImages.length === 0) {
      this.stats.reasons.noImages++;
      return {
        valid: false,
        reason: 'NO_IMAGES',
        detail: `Prodotto "${product.name}" senza immagini valide`,
        images: []
      };
    }

    // 2. Controllo e calcolo prezzo
    const finalPrice = this.calculatePrice(product.price);
    if (!finalPrice) {
      this.stats.reasons.invalidData++;
      return {
        valid: false,
        reason: 'INVALID_PRICE',
        detail: `Prezzo non valido: ${product.price}`,
        images: validImages
      };
    }

    // 3. Controllo soglia minima €20 (DOPO raddoppio)
    if (finalPrice < CONFIG.MIN_PRICE_THRESHOLD) {
      this.stats.reasons.lowPrice++;
      return {
        valid: false,
        reason: 'PRICE_TOO_LOW',
        detail: `Prezzo €${finalPrice} < €${CONFIG.MIN_PRICE_THRESHOLD}`,
        price: finalPrice,
        originalPrice: product.price,
        images: validImages
      };
    }
    
    // 4. NUOVO: Validazione stock numerica (FIX QUANTITY)
    if (product.stock !== undefined && product.stock !== null) {
      if (typeof product.stock !== 'number' || isNaN(product.stock) || product.stock < 0) {
        product.stock = 0; // Reset a 0 se non valido
      } else {
        product.stock = Math.floor(product.stock); // Assicura intero
      }
    } else {
      product.stock = 0; // Default se mancante
    }
    
    return {
      valid: true,
      price: finalPrice,
      originalPrice: product.price,
      images: validImages
    };
  }

  // ===== RICERCA PRODOTTO IN ECWID =====
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
        throw new Error(`Ecwid search error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.items && data.items.length > 0 ? data.items[0] : null;

    } catch (error) {
      console.error(`❌ Errore ricerca ${sku}:`, error.message);
      this.stats.reasons.apiError++;
      return null;
    }
  }

  // ===== CREAZIONE/AGGIORNAMENTO PRODOTTO ECWID =====
  async upsertEcwidProduct(product, validation, existingProduct = null) {
    try {
      const productData = {
        name: product.name,
        sku: product.sku,
        price: validation.price,
        quantity: product.stock, // Ora sempre numerico grazie alla validazione
        description: product.description || '',
        enabled: true,
        categories: product.category ? [{ name: product.category }] : []
      };

      // Aggiungi immagini se disponibili
      if (validation.images.length > 0) {
        productData.media = {
          images: validation.images.map(url => ({ url }))
        };
      }

      let url, method;
      
      if (existingProduct) {
        // Aggiornamento prodotto esistente
        url = `${CONFIG.ECWID_API_URL}/products/${existingProduct.id}`;
        method = 'PUT';
        this.stats.updated++;
      } else {
        // Creazione nuovo prodotto
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
      console.error(`❌ Errore upsert ${product.sku}:`, error.message);
      this.stats.errors++;
      this.errorSKUs.push({
        sku: product.sku,
        step: existingProduct ? 'update' : 'create',
        error: error.message
      });
      throw error;
    }
  }

  // ===== PROCESSAMENTO SINGOLO PRODOTTO =====
  async processProduct(product) {
    try {
      console.log(`🔄 Processo ${product.sku}...`);
      
      // 1. Validazione completa
      const validation = this.validateProduct(product);
      if (!validation.valid) {
        console.log(`⚠️ ${product.sku}: ${validation.reason} - ${validation.detail}`);
        this.stats.ignored++;
        return;
      }

      // 2. Ricerca prodotto esistente
      const existingProduct = await this.searchEcwidProduct(product.sku);

      // 3. Creazione o aggiornamento
      const action = existingProduct ? 'aggiornamento' : 'creazione';
      console.log(`📝 ${action.toUpperCase()} ${product.sku}...`);
      
      await this.upsertEcwidProduct(product, validation, existingProduct);
      
      console.log(`✅ ${product.sku}: ${action} completato (€${validation.price}, stock: ${product.stock})`);
      this.stats.processed++;

    } catch (error) {
      console.error(`❌ Errore processamento ${product.sku}:`, error.message);
      this.stats.errors++;
    }
  }

  // ===== PROCESSAMENTO BATCH =====
  async processBatch(products) {
    const batches = [];
    for (let i = 0; i < products.length; i += CONFIG.BATCH_SIZE) {
      batches.push(products.slice(i, i + CONFIG.BATCH_SIZE));
    }

    console.log(`📦 Processo ${products.length} prodotti in ${batches.length} batch di ${CONFIG.BATCH_SIZE}`);

    for (let i = 0; i < batches.length; i++) {
      console.log(`\n🚀 BATCH ${i + 1}/${batches.length}`);
      
      const batch = batches[i];
      
      // Processamento parallelo del batch
      await Promise.all(batch.map(product => this.processProduct(product)));
      
      // Pausa tra batch per evitare rate limiting
      if (i < batches.length - 1) {
        console.log(`⏳ Pausa ${CONFIG.BATCH_DELAY}ms tra batch...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
      }
    }
  }

  // ===== SINCRONIZZAZIONE PRINCIPALE =====
  async sync() {
    try {
      console.log('\n🚀 INIZIO SINCRONIZZAZIONE IBRIDA MSY → ECWID');
      console.log('===============================================');
      console.log(`📊 Modalità: ${CONFIG.SYNC_MODE}`);
      console.log(`🔗 CSV: ${CONFIG.DATA_SOURCES.CSV_URL}`);
      console.log(`🔗 JSON: ${CONFIG.DATA_SOURCES.JSON_URL}`);
      
      const startTime = Date.now();
      this.resetStats();

      // 1. Recupera prodotti (strategia multi-fonte)
      const result = await this.fetchProductsMultiSource();
      this.stats.total = result.products.length;
      this.stats.source = result.source;

      console.log(`\n📊 RISULTATO FETCH:`);
      console.log(`   🎯 Fonte utilizzata: ${result.source}`);
      console.log(`   📈 Prodotti totali: ${result.products.length}`);

      if (result.products.length === 0) {
        console.log('⚠️ Nessun prodotto trovato da processare');
        return this.generateReport(Date.now() - startTime);
      }

      // 2. Processamento prodotti in batch
      await this.processBatch(result.products);

      // 3. Report finale
      const duration = Date.now() - startTime;
      return this.generateReport(duration);

    } catch (error) {
      console.error('❌ ERRORE SINCRONIZZAZIONE GENERALE:', error.message);
      throw error;
    }
  }

  // ===== RESET STATISTICHE =====
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
      source: null
    };
    this.errorSKUs = [];
  }

  // ===== GENERAZIONE REPORT =====
  generateReport(duration) {
    const report = {
      success: this.stats.errors < this.stats.total * 0.5, // Success se < 50% errori
      timestamp: new Date().toISOString(),
      duration: `${Math.round(duration / 1000)}s`,
      stats: this.stats,
      errorSKUs: this.errorSKUs.slice(0, 20) // Prime 20 per debug
    };

    console.log('\n📊 REPORT FINALE SINCRONIZZAZIONE IBRIDA');
    console.log('==========================================');
    console.log(`🎯 Fonte Dati: ${this.stats.source}`);
    console.log(`⏱️ Durata: ${report.duration}`);
    console.log(`📈 Prodotti Totali: ${this.stats.total}`);
    console.log(`✅ Processati con Successo: ${this.stats.processed}`);
    console.log(`🆕 Nuovi Creati: ${this.stats.created}`);
    console.log(`📝 Esistenti Aggiornati: ${this.stats.updated}`);
    console.log(`⏭️ Ignorati (validazione): ${this.stats.ignored}`);
    console.log(`❌ Errori Totali: ${this.stats.errors}`);
    
    console.log(`\n📋 DETTAGLIO MOTIVI IGNORATI:`);
    console.log(`   🖼️ Senza immagini: ${this.stats.reasons.noImages}`);
    console.log(`   💰 Prezzo troppo basso: ${this.stats.reasons.lowPrice}`);
    console.log(`   📊 Dati non validi: ${this.stats.reasons.invalidData}`);
    console.log(`   🔗 Errori API Ecwid: ${this.stats.reasons.apiError}`);
    
    if (this.errorSKUs.length > 0) {
      console.log(`\n🔍 PRIMI ERRORI (${Math.min(10, this.errorSKUs.length)}/${this.errorSKUs.length}):`);
      this.errorSKUs.slice(0, 10).forEach(error => {
        console.log(`   ❌ ${error.sku} (${error.step}): ${error.error.substring(0, 100)}...`);
      });
    }

    const successRate = this.stats.total > 0 ? ((this.stats.processed / this.stats.total) * 100).toFixed(1) : '0';
    console.log(`\n🎯 TASSO DI SUCCESSO: ${successRate}%`);
    
    if (report.success) {
      console.log('✅ SINCRONIZZAZIONE COMPLETATA CON SUCCESSO!');
    } else {
      console.log('⚠️ SINCRONIZZAZIONE COMPLETATA CON AVVERTENZE');
    }

    return report;
  }
}

// ===== ISTANZA GLOBALE SERVIZIO SYNC =====
const syncService = new HybridMSYEcwidSync();

// ===== CONFIGURAZIONE EXPRESS =====
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Middleware di logging delle richieste
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ===== API ROUTES =====

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Hybrid MSY-Ecwid Sync',
    version: '1.0.0',
    mode: CONFIG.SYNC_MODE,
    sources: CONFIG.DATA_SOURCES
  });
});

// Sincronizzazione manuale
app.post('/sync', async (req, res) => {
  try {
    console.log('\n🔄 AVVIO SINCRONIZZAZIONE MANUALE...');
    console.log(`👤 Richiesta da: ${req.ip}`);
    
    const report = await syncService.sync();
    
    res.json({
      ...report,
      message: 'Sincronizzazione completata',
      requestTime: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ ERRORE SINCRONIZZAZIONE MANUALE:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
      message: 'Errore durante la sincronizzazione'
    });
  }
});

// Statistiche attuali
app.get('/stats', (req, res) => {
  res.json({
    currentStats: syncService.stats,
    errorCount: syncService.errorSKUs.length,
    recentErrors: syncService.errorSKUs.slice(-5), // Ultimi 5 errori
    config: {
      mode: CONFIG.SYNC_MODE,
      batchSize: CONFIG.BATCH_SIZE,
      minPriceThreshold: CONFIG.MIN_PRICE_THRESHOLD,
      requireImages: CONFIG.REQUIRE_IMAGES
    },
    timestamp: new Date().toISOString()
  });
});

// Test connessione fonti dati
app.get('/test-sources', async (req, res) => {
  const results = {
    timestamp: new Date().toISOString(),
    tests: {}
  };
  
  // Test CSV
  try {
    const csvResponse = await fetch(CONFIG.DATA_SOURCES.CSV_URL, { 
      method: 'HEAD',
      timeout: 10000 
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
      method: 'HEAD',
      timeout: 10000 
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

// ===== CRON JOB AUTOMATICO =====
// Sincronizzazione automatica ogni giorno alle 6:00 AM
cron.schedule('0 6 * * *', async () => {
  try {
    console.log('\n⏰ AVVIO SINCRONIZZAZIONE PROGRAMMATA (6:00 AM)...');
    const report = await syncService.sync();
    console.log('✅ Sincronizzazione programmata completata');
  } catch (error) {
    console.error('❌ ERRORE SINCRONIZZAZIONE PROGRAMMATA:', error.message);
  }
}, {
  timezone: "Europe/Rome"
});

// Sincronizzazione automatica ogni 6 ore (opzionale - commentato per default)
/*
cron.schedule('0 */6 * * *', async () => {
  try {
    console.log('\n⏰ SINCRONIZZAZIONE AUTOMATICA (ogni 6 ore)...');
    await syncService.sync();
  } catch (error) {
    console.error('❌ Errore sync automatica:', error.message);
  }
}, {
  timezone: "Europe/Rome"
});
*/

// ===== GESTIONE ERRORI GLOBALI =====
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM ricevuto, arresto graceful...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT ricevuto, arresto graceful...');
  process.exit(0);
});

// ===== AVVIO SERVER =====
app.listen(PORT, () => {
  console.log('\n🚀 HYBRID MSY-ECWID SYNC SERVER AVVIATO');
  console.log('=========================================');
  console.log(`🌐 Server: http://localhost:${PORT}`);
  console.log(`🎯 Modalità: ${CONFIG.SYNC_MODE}`);
  console.log(`📊 CSV Source: ${CONFIG.DATA_SOURCES.CSV_URL}`);
  console.log(`📊 JSON Source: ${CONFIG.DATA_SOURCES.JSON_URL}`);
  console.log('');
  console.log('📋 API ENDPOINTS:');
  console.log('   GET  /health        - Health check e configurazione');
  console.log('   POST /sync          - Sincronizzazione manuale');
  console.log('   GET  /stats         - Statistiche attuali');
  console.log('   GET  /test-sources  - Test connessione fonti dati');
  console.log('');
  console.log('⏰ SCHEDULAZIONE AUTOMATICA:');
  console.log('   📅 Ogni giorno alle 6:00 AM (Europe/Rome)');
  console.log('');
  console.log('🔄 STRATEGIA IBRIDA:');
  console.log('   1️⃣ Tenta CSV (più stabile)');
  console.log('   2️⃣ Fallback JSON se CSV fallisce');
  console.log('   3️⃣ Validazione quantity fix inclusa');
  console.log('   4️⃣ Resilienza massima garantita');
  console.log('');
  console.log('✅ Sistema pronto per la sincronizzazione!');
});
