   const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAZIONE =====
const CONFIG = {
  MSY_API_URL: 'https://www.msy.com.au/api/products',
  ECWID_STORE_ID: '329517085',
  ECWID_API_TOKEN: process.env.ECWID_API_TOKEN,
  ECWID_API_URL: `https://app.ecwid.com/api/v3/329517085`,
  
  // Configurazioni validazione
  REQUIRE_IMAGES: false,  // Cambiato a false per evitare blocchi
  MIN_PRICE_THRESHOLD: 20, // €20 minimo
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // 1 secondo
  
  // Configurazioni batch
  BATCH_SIZE: 10,
  BATCH_DELAY: 2000, // 2 secondi tra batch
};

// ===== CLASSE PRINCIPALE MSY-ECWID SYNC =====
class MSYEcwidSync {
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
      }
    };
    this.errorSKUs = [];
  }

  // ===== RECUPERO PRODOTTI MSY =====
  async fetchMSYProducts() {
    try {
      console.log('🔄 Recupero prodotti da MSY API...');
      const response = await fetch(CONFIG.MSY_API_URL);
      
      if (!response.ok) {
        throw new Error(`MSY API error: ${response.status}`);
      }
      
      const products = await response.json();
      console.log(`✅ Recuperati ${products.length} prodotti da MSY`);
      return products;
      
    } catch (error) {
      console.error('❌ Errore recupero prodotti MSY:', error.message);
      throw error;
    }
  }

  // ===== VALIDAZIONE IMMAGINI =====
  validateImages(product) {
    const validImages = [];
    
    // Controlla se esistono campi immagine nel prodotto
    if (product.image) validImages.push(product.image);
    if (product.images && Array.isArray(product.images)) {
      validImages.push(...product.images.filter(img => img && typeof img === 'string'));
    }
    if (product.gallery && Array.isArray(product.gallery)) {
      validImages.push(...product.gallery.filter(img => img && typeof img === 'string'));
    }
    
    return validImages;
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
    // 1. CONTROLLO IMMAGINI (OPZIONALE)
    const validImages = this.validateImages(product);
    
    if (CONFIG.REQUIRE_IMAGES && validImages.length === 0) {
      this.stats.reasons.noImages++;
      return {
        valid: false,
        reason: 'NO_IMAGES',
        detail: `Prodotto "${product.name}" senza immagini valide`,
        images: []
      };
    }

    // 2. CONTROLLO E RADDOPPIO PREZZO  
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

    // 3. CONTROLLO SOGLIA MINIMA €20 (DOPO RADDOPPIO!)
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
    
    // 4. NUOVO: Validazione quantity numerica
    if (product.stock !== undefined && product.stock !== null) {
      if (typeof product.stock !== 'number' || isNaN(product.stock) || product.stock < 0) {
        product.stock = 0;
      } else {
        product.stock = Math.floor(product.stock);
      }
    } else {
      product.stock = 0;
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
        }
      });

      if (!response.ok) {
        throw new Error(`Ecwid search error: ${response.status}`);
      }

      const data = await response.json();
      return data.items && data.items.length > 0 ? data.items[0] : null;

    } catch (error) {
      console.error(`❌ Errore ricerca prodotto ${sku}:`, error.message);
      return null;
    }
  }

  // ===== CREAZIONE/AGGIORNAMENTO PRODOTTO ECWID =====
  async upsertEcwidProduct(product, validation, existingProduct = null) {
    try {
      const productData = {
        name: product.name || `Prodotto ${product.sku}`,
        sku: product.sku,
        price: validation.price,
        quantity: product.stock,
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
        // Aggiornamento
        url = `${CONFIG.ECWID_API_URL}/products/${existingProduct.id}`;
        method = 'PUT';
        this.stats.updated++;
      } else {
        // Creazione
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
        body: JSON.stringify(productData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ecwid ${method} error: ${response.status} - ${errorText}`);
      }

      return await response.json();

    } catch (error) {
      console.error(`❌ Errore upsert prodotto ${product.sku}:`, error.message);
      this.stats.errors++;
      this.errorSKUs.push({
        sku: product.sku,
        step: existingProduct ? 'upsert' : 'create',
        error: error.message
      });
      throw error;
    }
  }

  // ===== PROCESSAMENTO SINGOLO PRODOTTO =====
  async processProduct(product) {
    try {
      console.log(`🔄 Processo ${product.sku}...`);
      
      // 1. Validazione
      const validation = this.validateProduct(product);
      if (!validation.valid) {
        console.log(`⚠️ ${product.sku}: ${validation.reason} - ${validation.detail}`);
        this.stats.ignored++;
        return;
      }

      // 2. Ricerca esistente
      console.log(`🔍 Cerco ${product.sku} in Ecwid...`);
      const existingProduct = await this.searchEcwidProduct(product.sku);

      // 3. Creazione/Aggiornamento
      const action = existingProduct ? 'aggiornamento' : 'creazione';
      console.log(`📝 ${action.toUpperCase()} ${product.sku}...`);
      
      await this.upsertEcwidProduct(product, validation, existingProduct);
      
      console.log(`✅ ${product.sku}: ${action} completato`);
      this.stats.processed++;

    } catch (error) {
      console.error(`❌ Errore processamento ${product.sku}:`, error.message);
      this.stats.errors++;
      this.errorSKUs.push({
        sku: product.sku,
        step: 'process',
        error: error.message
      });
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
      await Promise.all(batch.map(product => this.processProduct(product)));
      
      // Pausa tra batch per evitare rate limiting
      if (i < batches.length - 1) {
        console.log(`⏳ Pausa ${CONFIG.BATCH_DELAY}ms tra batch...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
      }
    }
  }

  // ===== SINCRONIZZAZIONE COMPLETA =====
  async sync() {
    try {
      console.log('\n🚀 INIZIO SINCRONIZZAZIONE MSY → ECWID');
      console.log('==========================================');
      
      const startTime = Date.now();
      this.resetStats();

      // 1. Recupera prodotti MSY
      const msyProducts = await this.fetchMSYProducts();
      this.stats.total = msyProducts.length;

      if (msyProducts.length === 0) {
        console.log('⚠️ Nessun prodotto trovato da MSY');
        return this.generateReport(Date.now() - startTime);
      }

      // 2. Processamento batch
      await this.processBatch(msyProducts);

      // 3. Report finale
      const duration = Date.now() - startTime;
      return this.generateReport(duration);

    } catch (error) {
      console.error('❌ ERRORE SINCRONIZZAZIONE:', error.message);
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
      }
    };
    this.errorSKUs = [];
  }

  // ===== GENERAZIONE REPORT =====
  generateReport(duration) {
    const report = {
      success: true,
      timestamp: new Date().toISOString(),
      duration: `${Math.round(duration / 1000)}s`,
      stats: this.stats,
      errorSKUs: this.errorSKUs.slice(0, 10) // Prime 10 per evitare log troppo lunghi
    };

    console.log('\n📊 REPORT SINCRONIZZAZIONE');
    console.log('==========================================');
    console.log(`⏱️ Durata: ${report.duration}`);
    console.log(`📈 Totale: ${this.stats.total}`);
    console.log(`✅ Processati: ${this.stats.processed}`);
    console.log(`🆕 Creati: ${this.stats.created}`);
    console.log(`📝 Aggiornati: ${this.stats.updated}`);
    console.log(`⏭️ Ignorati: ${this.stats.ignored}`);
    console.log(`❌ Errori: ${this.stats.errors}`);
    
    if (this.errorSKUs.length > 0) {
      console.log(`\n🔍 Primi errori (${Math.min(10, this.errorSKUs.length)}/${this.errorSKUs.length}):`);
      this.errorSKUs.slice(0, 10).forEach(error => {
        console.log(`   • ${error.sku} (${error.step}): ${error.error}`);
      });
    }

    return report;
  }
}

// ===== ISTANZA GLOBALE =====
const syncService = new MSYEcwidSync();

// ===== ROUTES API =====
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'MSY-Ecwid Sync'
  });
});

// Sync manuale
app.post('/sync', async (req, res) => {
  try {
    console.log('🔄 Avvio sincronizzazione manuale...');
    const report = await syncService.sync();
    res.json(report);
  } catch (error) {
    console.error('❌ Errore sincronizzazione:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Stats
app.get('/stats', (req, res) => {
  res.json({
    stats: syncService.stats,
    errors: syncService.errorSKUs.length,
    timestamp: new Date().toISOString()
  });
});

// ===== CRON JOB AUTOMATICO =====
// Esegui ogni giorno alle 6:00 AM
cron.schedule('0 6 * * *', async () => {
  try {
    console.log('⏰ Avvio sincronizzazione programmata...');
    await syncService.sync();
  } catch (error) {
    console.error('❌ Errore sincronizzazione programmata:', error.message);
  }
}, {
  timezone: "Europe/Rome"
});

// ===== AVVIO SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Server avviato su porta ${PORT}`);
  console.log('📋 API disponibili:');
  console.log('   GET  /health - Health check');
  console.log('   POST /sync   - Sincronizzazione manuale');  
  console.log('   GET  /stats  - Statistiche');
  console.log('⏰ Sincronizzazione automatica: ogni giorno alle 6:00 AM');
});

// Gestione errori non catturati
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});
