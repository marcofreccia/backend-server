// ----- GLOBAL ERROR HANDLING -----
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

// ----- IMPORT & CONFIG -----
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

// ----- HEALTHCHECK: PER RAILWAY -----
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ------ VARIABILI AMBIENTE ------
const ECWID_STORE_ID = process.env.ECWID_STORE_ID;
const ECWID_TOKEN = process.env.ECWID_SECRET_TOKEN;
const MSY_URL = 'https://msy.madtec.be/price_list/pricelist_en.json';

// ✅ CONFIGURAZIONI FILTRO PREZZO
const PRICE_MULTIPLIER = 2;           // Moltiplicatore prezzo MSY (x2)
const MIN_PRICE_THRESHOLD = 40;       // Prezzo minimo finale in euro
const ENABLE_PRICE_FILTER = true;     // Attiva/disattiva filtro
const REQUIRE_IMAGES = true;          // Richiedi almeno 1 immagine valida

// ✅ STATO GLOBALE DEL SYNC
let syncStatus = {
  running: false,
  lastRun: null,
  result: null,
  progress: null
};

// ====== MAPPA CATEGORIE ECWID ======
const mappaCategorieEcwid = {
  "PRE-ORDER": 176669407,
  "FITNESS": 185397803,
  "ELECTROMANEGERS": 185397545,
  "PERFUME": 185397804,
  "ELDERLY CARE": 185397546,
  "TOOLS": 185397800,
  "Kitchen & Tableware": 185397797,
  "Kitchenware": 185397802,
  "Pet Care": 185397801,
  "Beauty & Wellness": 185397799,
  "Home and Living": 185397798,
  "Appliances": 185397544
};

// ----- LOGGING HELPER -----
function log(...args) {
  const timestamp = new Date().toISOString();
  console.log(timestamp, ...args);
}

// ✅ HELPER PER VALIDARE IMMAGINI
async function validateImageUrl(url) {
  try {
    const response = await fetch(url, { 
      method: 'HEAD', 
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProductSync/1.0)'
      }
    });
    
    if (!response.ok) return false;
    
    const contentType = response.headers.get('content-type');
    return contentType && contentType.startsWith('image/');
  } catch (error) {
    log(`❌ Immagine non valida: ${url} - ${error.message}`);
    return false;
  }
}

// ----- ECWID FETCH HELPER -----
async function ecwidFetch(endpoint, options = {}) {
  const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${ECWID_TOKEN}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  
  // ✅ RETRY LOGIC PER 503 ERRORI
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch(url, { ...options, headers });
      
      // ✅ GESTIONE 503 SERVICE UNAVAILABLE
      if (response.status === 503) {
        retries--;
        if (retries === 0) throw new Error(`503 Service Unavailable after retries`);
        
        const delay = (4 - retries) * 2000; // 2s, 4s, 6s
        log(`⚠️ 503 Error, retry in ${delay}ms... (${retries} remaining)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // ✅ VERIFICA RISPOSTA HTML INVECE DI JSON
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
        throw new Error(`Received HTML instead of JSON (Status: ${response.status})`);
      }
      
      const data = await response.json();
      return data;
      
    } catch (error) {
      if (retries === 1) throw error;
      retries--;
      
      const delay = (4 - retries) * 1000;
      log(`⚠️ API Error: ${error.message}, retry in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ------ FUNZIONE DI SYNC CON FILTRO PREZZO E IMMAGINI ------
async function syncMSYtoEcwid() {
  log('🚀 Inizio sync MSY→Ecwid con filtro prezzo e validazione immagini...');
  
  // ✅ AGGIORNA STATO SYNC
  syncStatus.running = true;
  syncStatus.lastRun = new Date().toISOString();
  syncStatus.result = null;
  syncStatus.progress = { current: 0, total: 0, phase: 'downloading' };
  
  try {
    const listinoResp = await fetch(MSY_URL);
    if (!listinoResp.ok) throw new Error(`Errore download MSY HTTP ${listinoResp.status}`);
    const listino = await listinoResp.json();
    if (!listino || !Array.isArray(listino.price_list)) throw new Error('price_list non valido!');

    let countCreated = 0, countUpdated = 0, countIgnored = 0, countError = 0;
    let countFilteredPrice = 0, countFilteredImages = 0;
    const errorSKUs = [];

    log(`📦 Processando ${listino.price_list.length} prodotti...`);
    syncStatus.progress.total = listino.price_list.length;
    syncStatus.progress.phase = 'processing';

    for (const [i, prodotto] of listino.price_list.entries()) {
      // ✅ AGGIORNA PROGRESS
      syncStatus.progress.current = i + 1;
      
      const sku = prodotto.article_num && String(prodotto.article_num).trim();
      if (!sku) {
        countIgnored++;
        log(`[${i}] ⏭️ Nessun SKU, prodotto ignorato`, prodotto.name || prodotto);
        continue;
      }

      // ✅ CALCOLO PREZZO FINALE
      const prezzoMSY = Number(prodotto.price) || 0;
      const prezzoFinale = prezzoMSY * PRICE_MULTIPLIER;

      // ✅ FILTRO PREZZO MINIMO
      if (ENABLE_PRICE_FILTER && prezzoFinale < MIN_PRICE_THRESHOLD) {
        countIgnored++;
        countFilteredPrice++;
        log(`[${i}] 🚫 FILTRATO PREZZO SKU ${sku}: ${prezzoFinale}€ < ${MIN_PRICE_THRESHOLD}€ (MSY: ${prezzoMSY}€)`);
        continue;
      }

      // ✅ VALIDAZIONE E FILTRO IMMAGINI
      const imageUrls = ['photo_1','photo_2','photo_3','photo_4','photo_5']
        .map(c => prodotto[c])
        .filter(url => url && typeof url === "string" && url.startsWith("http"));

      let validImages = [];
      if (imageUrls.length > 0) {
        // Valida massimo 3 immagini per velocità
        const imagesToValidate = imageUrls.slice(0, 3);
        
        for (const url of imagesToValidate) {
          const isValid = await validateImageUrl(url);
          if (isValid) {
            validImages.push({ url });
          }
        }
      }

      // ✅ FILTRO IMMAGINI OBBLIGATORIE
      if (REQUIRE_IMAGES && validImages.length === 0) {
        countIgnored++;
        countFilteredImages++;
        log(`[${i}] 🖼️ FILTRATO IMMAGINI SKU ${sku}: nessuna immagine valida trovata`);
        continue;
      }

      // ✅ RICERCA PRODOTTO ESISTENTE SU ECWID
      let found = null;
      try {
        const searchRes = await ecwidFetch(`products?sku=${encodeURIComponent(sku)}`);
        found = searchRes && Array.isArray(searchRes.items) && searchRes.items[0];
      } catch (err) {
        countError++;
        log(`[${i}] ❌ Errore Ecwid search SKU ${sku}:`, err.message);
        errorSKUs.push({ sku, step: 'search', error: err.message || err });
        continue;
      }

      // ✅ CATEGORIA ASSEGNATA O DEFAULT PRE-ORDER
      let idCategoriaEcwid = 176669407; // Default PRE-ORDER
      if (typeof prodotto.cat === 'string' && mappaCategorieEcwid[prodotto.cat.trim()]) {
        idCategoriaEcwid = mappaCategorieEcwid[prodotto.cat.trim()];
      }

      // ✅ COSTRUZIONE PRODOTTO ECWID CON PREZZO FINALE
      const ecwidProd = {
        sku,
        name: prodotto.name || sku,
        price: prezzoFinale, // ✅ PREZZO RADDOPPIATO
        compareToPrice: prezzoFinale * 1.2, // Prezzo barrato (+20%)
        quantity: prodotto.stock != null ? Number(prodotto.stock) : 0,
        weight: prodotto.weight ? Number(prodotto.weight) : undefined,
        description: prodotto.description,
        enabled: true,
        images: validImages, // ✅ SOLO IMMAGINI VALIDATE
        brand: prodotto.brand,
        categories: [idCategoriaEcwid],
        attributes: [
          { name: 'MSY Price', value: String(prezzoMSY) + '€' }, // ✅ PREZZO ORIGINALE MSY
          { name: 'Recommended Price', value: prodotto.price_recommended != null ? String(prodotto.price_recommended) : "" },
          { name: 'VAT', value: prodotto.vat_rate != null ? String(prodotto.vat_rate) : "" },
          { name: 'Category', value: prodotto.cat != null ? String(prodotto.cat) : "" },
          { name: 'Subcategory', value: prodotto.scat != null ? String(prodotto.scat) : "" },
          { name: 'EAN', value: prodotto.ean != null ? String(prodotto.ean) : "" },
          { name: 'Volume', value: prodotto.volume != null ? String(prodotto.volume) : "" },
          { name: 'Height', value: prodotto.height != null ? String(prodotto.height) : "" },
          { name: 'Width', value: prodotto.width != null ? String(prodotto.width) : "" },
          { name: 'Length', value: prodotto.length != null ? String(prodotto.length) : "" }
        ]
      };

      // ✅ UPSERT SU ECWID CON GESTIONE ERRORI
      try {
        let ecwidResp;
        if (found) {
          // UPDATE PRODOTTO ESISTENTE
          ecwidResp = await ecwidFetch(`products/${found.id}`, {
            method: 'PUT',
            body: JSON.stringify(ecwidProd),
          });
          if (ecwidResp && ecwidResp.errorCode) {
            countError++;
            log(`[${i}] ❌ ERRORE Ecwid update SKU ${sku}:`, ecwidResp.errorCode, ecwidResp.errorMessage);
            errorSKUs.push({ sku, step: 'update', error: `${ecwidResp.errorCode} - ${ecwidResp.errorMessage}` });
            continue;
          }
          countUpdated++;
          log(`[${i}] ✅ ${sku}: Aggiornato su Ecwid (${found.id}) - Prezzo: ${prezzoFinale}€, Immagini: ${validImages.length}`);
        } else {
          // CREATE NUOVO PRODOTTO
          ecwidResp = await ecwidFetch(`products`, {
            method: 'POST',
            body: JSON.stringify(ecwidProd),
          });
          if (ecwidResp && ecwidResp.errorCode) {
            countError++;
            log(`[${i}] ❌ ERRORE Ecwid create SKU ${sku}:`, ecwidResp.errorCode, ecwidResp.errorMessage);
            errorSKUs.push({ sku, step: 'create', error: `${ecwidResp.errorCode} - ${ecwidResp.errorMessage}` });
            continue;
          }
          countCreated++;
          log(`[${i}] ✅ ${sku}: Creato su Ecwid - Prezzo: ${prezzoFinale}€, Immagini: ${validImages.length}`);
        }
      } catch (err) {
        countError++;
        log(`[${i}] ❌ ERRORE Ecwid upsert SKU ${sku}:`, err.message || err);
        errorSKUs.push({ sku, step: 'upsert', error: err.message || err });
      }

      // ✅ PAUSA TRA RICHIESTE PER EVITARE RATE LIMIT
      if (i % 5 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // ✅ PROGRESS LOG
      if (i % 10 === 0) {
        log(`📊 Progresso: ${i}/${listino.price_list.length} - Sync: ${countCreated + countUpdated}, Filtrati: ${countFilteredPrice + countFilteredImages}`);
      }
    }

    // ✅ REPORT FINALE DETTAGLIATO
    if (errorSKUs.length > 0) {
      log('⚠️ === ERRORI RISCONTRATI DURANTE LA SYNC ===');
      errorSKUs.slice(0, 10).forEach(e => log(`SKU ${e.sku} [${e.step}]: ${e.error}`));
      if (errorSKUs.length > 10) {
        log(`... e altri ${errorSKUs.length - 10} errori`);
      }
    }

    log(`🏁 === SYNC COMPLETATA ===`);
    log(`✅ Creati: ${countCreated}`);
    log(`🔄 Aggiornati: ${countUpdated}`);
    log(`⏭️ Ignorati totali: ${countIgnored}`);
    log(`  └── 💰 Filtrati per prezzo < ${MIN_PRICE_THRESHOLD}€: ${countFilteredPrice}`);
    log(`  └── 🖼️ Filtrati per mancanza immagini: ${countFilteredImages}`);
    log(`❌ Errori: ${countError}`);
    log(`📊 Tasso successo: ${((countCreated + countUpdated) / listino.price_list.length * 100).toFixed(1)}%`);

    const result = { 
      success: true,
      created: countCreated, 
      updated: countUpdated, 
      ignored: countIgnored, 
      error: countError, 
      errorSKUs,
      filteredByPrice: countFilteredPrice,
      filteredByImages: countFilteredImages,
      priceMultiplier: PRICE_MULTIPLIER,
      minPriceThreshold: MIN_PRICE_THRESHOLD,
      completedAt: new Date().toISOString()
    };

    // ✅ AGGIORNA STATO FINALE
    syncStatus.running = false;
    syncStatus.result = result;
    syncStatus.progress.phase = 'completed';

    return result;

  } catch (error) {
    log('💥 Errore durante sync:', error.message);
    
    // ✅ AGGIORNA STATO ERRORE
    syncStatus.running = false;
    syncStatus.result = { success: false, error: error.message };
    syncStatus.progress.phase = 'failed';
    
    throw error;
  }
}

// ===== ROUTE PER AVVIARE LA SYNC ASINCRONA =====
app.post('/v1/ecwid-sync', async (req, res) => {
  try {
    // ✅ CONTROLLA SE SYNC GIÀ IN CORSO
    if (syncStatus.running) {
      return res.status(409).json({
        success: false,
        message: 'Sync già in corso',
        status: syncStatus,
        checkStatusAt: '/v1/sync-status'
      });
    }

    log(`🔄 Avviato sync asincrono da ${req.ip}`);

    // ✅ RISPOSTA IMMEDIATA
    res.status(202).json({
      success: true,
      message: 'Sync avviato in background',
      estimatedDuration: '10-15 minuti',
      priceFilter: `min ${MIN_PRICE_THRESHOLD}€ (moltiplicatore x${PRICE_MULTIPLIER})`,
      imageValidation: REQUIRE_IMAGES ? 'Obbligatoria' : 'Opzionale',
      checkStatusAt: '/v1/sync-status',
      timestamp: new Date().toISOString()
    });

    // ✅ AVVIA SYNC IN BACKGROUND
    setImmediate(() => {
      syncMSYtoEcwid()
        .then(result => {
          log('✅ Background sync completato:', result);
        })
        .catch(error => {
          log('❌ Background sync fallito:', error.message);
        });
    });

  } catch (err) {
    log('💥 Errore in /v1/ecwid-sync:', err.message || err);
    res.status(500).json({ 
      success: false, 
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ ROUTE PER CONTROLLARE STATO SYNC
app.get('/v1/sync-status', (req, res) => {
  res.status(200).json({
    ...syncStatus,
    serverTime: new Date().toISOString(),
    config: {
      priceMultiplier: PRICE_MULTIPLIER,
      minPriceThreshold: MIN_PRICE_THRESHOLD,
      enablePriceFilter: ENABLE_PRICE_FILTER,
      requireImages: REQUIRE_IMAGES
    }
  });
});

// ✅ ROUTE PER CONTROLLARE CONFIGURAZIONE
app.get('/v1/config', (req, res) => {
  res.status(200).json({
    priceMultiplier: PRICE_MULTIPLIER,
    minPriceThreshold: MIN_PRICE_THRESHOLD,
    enablePriceFilter: ENABLE_PRICE_FILTER,
    requireImages: REQUIRE_IMAGES,
    storeId: ECWID_STORE_ID,
    msyUrl: MSY_URL,
    serverTime: new Date().toISOString()
  });
});

// ✅ ROUTE PER AVVIARE SYNC AUTOMATICO (GET)
app.get('/v1/start-sync', async (req, res) => {
  if (syncStatus.running) {
    return res.status(409).json({
      message: 'Sync già in corso',
      status: syncStatus
    });
  }

  res.status(200).json({ 
    message: 'Sync automatico avviato',
    startTime: new Date().toISOString()
  });
  
  // Avvia dopo 3 secondi
  setTimeout(() => {
    log('🤖 Avvio sync automatico...');
    syncMSYtoEcwid()
      .then(result => log('✅ Auto-sync completato:', result))
      .catch(error => log('❌ Auto-sync fallito:', error.message));
  }, 3000);
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
  log(`🚀 Server in ascolto sulla porta ${PORT}`);
  log(`💰 Filtro prezzo attivo: min ${MIN_PRICE_THRESHOLD}€ (moltiplicatore: x${PRICE_MULTIPLIER})`);
  log(`🖼️ Validazione immagini: ${REQUIRE_IMAGES ? 'OBBLIGATORIA' : 'OPZIONALE'}`);
  log(`📡 Endpoints disponibili:`);
  log(`  - POST /v1/ecwid-sync (sync asincrono)`);
  log(`  - GET  /v1/sync-status (stato sync)`);
  log(`  - GET  /v1/config (configurazione)`);
  log(`  - GET  /v1/start-sync (avvio automatico)`);
});

// === CORRETTA: NON mettere altro dopo questa riga ===
module.exports = { syncMSYtoEcwid };
