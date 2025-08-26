// ----- LOGGING HELPER -----
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'warn' : 'info');

function log(message, level = 'info') {
    if (logLevel === 'warn' && level === 'info') return;
    if (logLevel === 'error' && level !== 'error') return;
    const timestamp = new Date().toISOString();
    console.log(`[${level.toUpperCase()}]`, timestamp, message);
}

// ----- GLOBAL ERROR HANDLING -----
process.on('unhandledRejection', (reason, p) => {
    log(`Unhandled Rejection at: ${p}, reason: ${reason}`, 'error');
});

process.on('uncaughtException', (err) => {
    log(`Uncaught Exception thrown: ${err}`, 'error');
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
const ECWID_STORE_ID = process.env.ECWID_STORE_ID || "29517085";
const ECWID_TOKEN = process.env.ECWID_SECRET_TOKEN;
const MSY_URL = 'https://msy.madtec.be/price_list/pricelist_en.json';

// ✅ CONFIGURAZIONI FILTRO PREZZO
const PRICE_MULTIPLIER = 2;
const MIN_PRICE_THRESHOLD = 40;
const ENABLE_PRICE_FILTER = true;
const REQUIRE_IMAGES = true;

// ✅ STATO GLOBALE DEL SYNC
let syncStatus = {
    running: false,
    lastRun: null,
    result: null,
    progress: null
};

// ====== 🔧 FIX #1: MAPPA CATEGORIE CORRETTA ======
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
    "Appliances": 185397544,
    // 🔧 Aggiungi mapping MSY specifici
    "Computer": 185397544,
    "Notebook": 185397545,
    "Monitor": 185397546,
    "Accessori": 185397800,
    "default": 176669407 // Fallback PRE-ORDER
};

// ✅ 🔧 FIX #2: VALIDAZIONE IMMAGINI ROBUSTA
async function validateImageUrl(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        return false;
    }
    
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ProductSync/1.0)'
            }
        });
        
        if (!response.ok) {
            log(`❌ Immagine HTTP error ${response.status}: ${url}`, 'warn');
            return false;
        }
        
        const contentType = response.headers.get('content-type');
        const isImage = contentType && contentType.startsWith('image/');
        
        if (!isImage) {
            log(`❌ Content-type non valido (${contentType}): ${url}`, 'warn');
            return false;
        }
        
        return true;
        
    } catch (error) {
        log(`❌ Errore validazione immagine ${url}: ${error.message}`, 'warn');
        return false;
    }
}

// ----- ECWID FETCH HELPER CON RETRY -----
async function ecwidFetch(endpoint, options = {}) {
    const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/${endpoint}`;
    const headers = {
        'Authorization': `Bearer ${ECWID_TOKEN}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await fetch(url, { ...options, headers });

            if (response.status === 503) {
                retries--;
                if (retries === 0) throw new Error(`503 Service Unavailable after retries`);
                const delay = (4 - retries) * 2000;
                log(`⚠️ 503 Error, retry in ${delay}ms... (${retries} remaining)`, 'warn');
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

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
            log(`⚠️ API Error: ${error.message}, retry in ${delay}ms...`, 'warn');
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// ------ 🔧 FIX #3: FUNZIONE SYNC CORRETTA ------
async function syncMSYtoEcwid() {
    log('🚀 Inizio sync MSY→Ecwid con filtri corretti...', 'info');

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

        log(`📦 Processando ${listino.price_list.length} prodotti...`, 'info');
        syncStatus.progress.total = listino.price_list.length;
        syncStatus.progress.phase = 'processing';

        for (const [i, prodotto] of listino.price_list.entries()) {
            syncStatus.progress.current = i + 1;

            const sku = prodotto.article_num && String(prodotto.article_num).trim();
            if (!sku) {
                countIgnored++;
                continue;
            }

            // ✅ FILTRO PREZZO MINIMO
            const prezzoMSY = Number(prodotto.price) || 0;
            const prezzoFinale = prezzoMSY * PRICE_MULTIPLIER;

            if (ENABLE_PRICE_FILTER && prezzoFinale < MIN_PRICE_THRESHOLD) {
                countIgnored++;
                countFilteredPrice++;
                log(`[${i}] 🚫 FILTRATO PREZZO SKU ${sku}: ${prezzoFinale}€ < ${MIN_PRICE_THRESHOLD}€`, 'info');
                continue;
            }

            // ✅ 🔧 FIX #3: VALIDAZIONE IMMAGINI RIGIDA
            const imageUrls = ['photo_1','photo_2','photo_3','photo_4','photo_5']
                .map(c => prodotto[c])
                .filter(url => url && typeof url === "string" && url.startsWith("http"));

            let validImages = [];
            
            if (imageUrls.length > 0) {
                // Valida solo prime 2 immagini per velocità
                const imagesToValidate = imageUrls.slice(0, 2);
                for (const url of imagesToValidate) {
                    const isValid = await validateImageUrl(url);
                    if (isValid) {
                        validImages.push({ url });
                    }
                }
            }

            // 🔧 FIX #3: SE REQUIRE_IMAGES=true E NON CI SONO IMMAGINI → SKIP TOTALE
            if (REQUIRE_IMAGES && validImages.length === 0) {
                countIgnored++;
                countFilteredImages++;
                log(`[${i}] 🖼️ FILTRATO IMMAGINI SKU ${sku}: nessuna immagine valida`, 'info');
                continue; // ✅ SKIP COMPLETO DEL PRODOTTO
            }

            // ✅ RICERCA PRODOTTO ESISTENTE
            let found = null;
            try {
                const searchRes = await ecwidFetch(`products?sku=${encodeURIComponent(sku)}`);
                found = searchRes && Array.isArray(searchRes.items) && searchRes.items[0];
            } catch (err) {
                countError++;
                errorSKUs.push({ sku, step: 'search', error: err.message });
                continue;
            }

            // ✅ 🔧 FIX #1: CATEGORIZZAZIONE INTELLIGENTE
            let idCategoriaEcwid = mappaCategorieEcwid["default"]; // PRE-ORDER fallback
            
            // Prova mapping per categoria MSY
            if (prodotto.cat && typeof prodotto.cat === 'string') {
                const catMapped = mappaCategorieEcwid[prodotto.cat.trim()];
                if (catMapped) {
                    idCategoriaEcwid = catMapped;
                    log(`[${i}] 📁 Categoria mappata: "${prodotto.cat}" → ${catMapped}`, 'info');
                }
            }

            // ✅ 🔧 FIX #2: COSTRUZIONE PRODOTTO SENZA HOMEPAGE
            const ecwidProd = {
                sku,
                name: prodotto.name || sku,
                price: prezzoFinale,
                compareToPrice: prezzoFinale * 1.2,
                quantity: prodotto.stock != null ? Number(prodotto.stock) : 0,
                weight: prodotto.weight ? Number(prodotto.weight) : undefined,
                description: prodotto.description,
                enabled: true,
                // 🔧 FIX #2: IMPEDISCI HOMEPAGE/FEATURED
                isFeatured: false,
                showOnFrontpage: false,
                // ✅ SOLO IMMAGINI VALIDATE
                images: validImages,
                brand: prodotto.brand,
                // 🔧 FIX #1: CATEGORIA SPECIFICA, NON PRE-ORDER GENERICO
                categories: [idCategoriaEcwid],
                attributes: [
                    { name: 'MSY Price', value: String(prezzoMSY) + '€' },
                    { name: 'Category', value: prodotto.cat || "" },
                    { name: 'Subcategory', value: prodotto.scat || "" },
                    { name: 'EAN', value: prodotto.ean || "" }
                ]
            };

            // ✅ UPSERT SU ECWID
            try {
                let ecwidResp;
                if (found) {
                    // UPDATE
                    ecwidResp = await ecwidFetch(`products/${found.id}`, {
                        method: 'PUT',
                        body: JSON.stringify(ecwidProd),
                    });
                    
                    if (ecwidResp && ecwidResp.errorCode) {
                        countError++;
                        errorSKUs.push({ sku, step: 'update', error: `${ecwidResp.errorCode}` });
                        continue;
                    }
                    
                    countUpdated++;
                    log(`[${i}] ✅ ${sku}: AGGIORNATO - Prezzo: ${prezzoFinale}€, Cat: ${idCategoriaEcwid}, Img: ${validImages.length}`, 'info');
                } else {
                    // CREATE
                    ecwidResp = await ecwidFetch(`products`, {
                        method: 'POST',
                        body: JSON.stringify(ecwidProd),
                    });
                    
                    if (ecwidResp && ecwidResp.errorCode) {
                        countError++;
                        errorSKUs.push({ sku, step: 'create', error: `${ecwidResp.errorCode}` });
                        continue;
                    }
                    
                    countCreated++;
                    log(`[${i}] ✅ ${sku}: CREATO - Prezzo: ${prezzoFinale}€, Cat: ${idCategoriaEcwid}, Img: ${validImages.length}`, 'info');
                }
            } catch (err) {
                countError++;
                errorSKUs.push({ sku, step: 'upsert', error: err.message });
            }

            // ✅ PAUSA ANTI-RATE-LIMIT
            if (i % 5 === 0 && i > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Progress log
            if (i % 20 === 0) {
                log(`📊 ${i}/${listino.price_list.length} - Creati: ${countCreated}, Aggiornati: ${countUpdated}, Filtrati: ${countFilteredPrice + countFilteredImages}`, 'info');
            }
        }

        // ✅ REPORT FINALE
        log(`🏁 === SYNC COMPLETATA ===`, 'info');
        log(`✅ Creati: ${countCreated}`, 'info');
        log(`🔄 Aggiornati: ${countUpdated}`, 'info');
        log(`⏭️ Ignorati: ${countIgnored}`, 'info');
        log(`💰 Filtrati prezzo < ${MIN_PRICE_THRESHOLD}€: ${countFilteredPrice}`, 'info');
        log(`🖼️ Filtrati senza immagini: ${countFilteredImages}`, 'info');
        log(`❌ Errori: ${countError}`, 'info');

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

        syncStatus.running = false;
        syncStatus.result = result;
        syncStatus.progress.phase = 'completed';
        
        return result;

    } catch (error) {
        log('💥 Errore durante sync: ' + error.message, 'error');
        syncStatus.running = false;
        syncStatus.result = { success: false, error: error.message };
        syncStatus.progress.phase = 'failed';
        throw error;
    }
}

// ===== ROUTES =====

// 🔧 SYNC ASINCRONO
app.post('/v1/ecwid-sync', async (req, res) => {
    try {
        if (syncStatus.running) {
            return res.status(409).json({
                success: false,
                message: 'Sync già in corso',
                status: syncStatus,
                checkStatusAt: '/v1/sync-status'
            });
        }

        log(`🔄 Avviato sync asincrono da ${req.ip}`, 'info');
        
        res.status(202).json({
            success: true,
            message: 'Sync avviato in background',
            estimatedDuration: '10-15 minuti',
            priceFilter: `min ${MIN_PRICE_THRESHOLD}€ (x${PRICE_MULTIPLIER})`,
            imageValidation: REQUIRE_IMAGES ? 'OBBLIGATORIA' : 'OPZIONALE',
            checkStatusAt: '/v1/sync-status',
            timestamp: new Date().toISOString()
        });

        // Avvia in background
        setImmediate(() => {
            syncMSYtoEcwid()
                .then(result => log('✅ Background sync OK: ' + JSON.stringify(result), 'info'))
                .catch(error => log('❌ Background sync FAIL: ' + error.message, 'error'));
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ✅ STATUS SYNC
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

// ✅ CONFIGURAZIONE
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

// ✅ AVVIO AUTOMATICO
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

    setTimeout(() => {
        log('🤖 Avvio sync automatico...', 'info');
        syncMSYtoEcwid()
            .then(result => log('✅ Auto-sync OK: ' + JSON.stringify(result), 'info'))
            .catch(error => log('❌ Auto-sync FAIL: ' + error.message, 'error'));
    }, 3000);
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
    log(`🚀 Server MSY-Ecwid Sync v2.0 porta ${PORT}`, 'info');
    log(`💰 Filtro prezzo: min ${MIN_PRICE_THRESHOLD}€ (x${PRICE_MULTIPLIER})`, 'info');
    log(`🖼️ Validazione immagini: ${REQUIRE_IMAGES ? 'OBBLIGATORIA' : 'OPZIONALE'}`, 'info');
    log(`📡 Endpoints: /v1/ecwid-sync, /v1/sync-status, /v1/config`, 'info');
});

module.exports = { syncMSYtoEcwid };
