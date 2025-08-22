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
const fetch = require('node-fetch'); // versione CJS, va bene su Railway

const app = express();
app.use(express.json());

// ----- MIDDLEWARE LOGGING GLOBALE -----
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Variabili d'ambiente: aggiungile su .env o variabili Railway!
const ECWID_STORE_ID = process.env.ECWID_STORE_ID;
const ECWID_TOKEN = process.env.ECWID_SECRET_TOKEN;
const MSY_URL = 'https://msy.madtec.be/price_list/pricelist_en.json';

// Helper per chiamate Ecwid API
async function ecwidFetch(endpoint, options = {}) {
  const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${ECWID_TOKEN}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = await response.json();
  return data;
}

// Logging helper
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Funzione di sincronizzazione completa (con immagini e attributi)
async function syncMSYtoEcwid() {
  log('Inizio sync MSY→Ecwid...');
  // Scarica listino
  const listinoResp = await fetch(MSY_URL);
  if (!listinoResp.ok) throw new Error(`MSY errore HTTP ${listinoResp.status}`);
  const listino = await listinoResp.json();
  if (!listino || !Array.isArray(listino.price_list)) throw new Error('price_list non valido!');

  let countCreated = 0, countUpdated = 0, countIgnored = 0, countError = 0;
  for (const [i, prodotto] of listino.price_list.entries()) {
    const sku = prodotto.article_num && String(prodotto.article_num).trim();
    if (!sku) {
      countIgnored++;
      log(`[${i}] Nessun SKU, prodotto ignorato`, prodotto.name || prodotto);
      continue;
    }
    let found = null;
    try {
      const searchRes = await ecwidFetch(`products?sku=${encodeURIComponent(sku)}`);
      found = searchRes && Array.isArray(searchRes.items) && searchRes.items[0];
    } catch (err) {
      countError++;
      log(`[${i}] Errore Ecwid search SKU ${sku}:`, err);
      continue;
    }

    // PREPARA PRODOTTO ecwid (puoi estendere qui immagini, attributi custom)
    const images = ['photo_1','photo_2','photo_3','photo_4','photo_5']
      .map(c => prodotto[c])
      .filter(Boolean)
      .map(url => ({ url }));
    const ecwidProd = {
      sku,
      name: prodotto.name || sku,
      price: Number(prodotto.price) || 0,
      quantity: prodotto.stock != null ? Number(prodotto.stock) : 0,
      weight: prodotto.weight ? Number(prodotto.weight) : undefined,
      description: prodotto.description,
      images,
      brand: prodotto.brand,
      attributes: [
        { name: 'Recommended Price', value: prodotto.price_recommended },
        { name: 'VAT', value: prodotto.vat_rate },
        { name: 'Category', value: prodotto.cat },
        { name: 'Subcategory', value: prodotto.scat },
        { name: 'EAN', value: prodotto.ean },
        { name: 'Volume', value: prodotto.volume },
        { name: 'Height', value: prodotto.height },
        { name: 'Width', value: prodotto.width },
        { name: 'Length', value: prodotto.length }
      ]
    };

    try {
      if (found) {
        // Aggiorna
        await ecwidFetch(`products/${found.id}`, {
          method: 'PUT',
          body: JSON.stringify(ecwidProd),
        });
        countUpdated++;
        log(`[${i}] ${sku}: Aggiornato Ecwid (${found.id})`);
      } else {
        // Crea nuovo prodotto
        await ecwidFetch(`products`, {
          method: 'POST',
          body: JSON.stringify(ecwidProd),
        });
        countCreated++;
        log(`[${i}] ${sku}: Creato su Ecwid`);
      }
    } catch (err) {
      countError++;
      log(`[${i}] ERRORE Ecwid upsert SKU ${sku}:`, err.message || err);
    }
    if (i % 10 === 0) log(`Progresso: ${i}/${listino.price_list.length}`);
  }
  log(`Sync COMPLETA Ecwid: ${countCreated} creati, ${countUpdated} aggiornati, ${countIgnored} ignorati, ${countError} errori`);
  return { created: countCreated, updated: countUpdated, ignored: countIgnored, error: countError };
}

// ===== ROUTE PER AVVIO SYNC MANUALE =====
app.post('/v1/ecwid-sync', async (req, res) => {
  try {
    const risultato = await syncMSYtoEcwid();
    res.status(200).json({ success: true, ...risultato });
  } catch (err) {
    log('Errore in /v1/ecwid-sync:', err.message || err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, () => { log(`Server in ascolto sulla porta ${PORT}`); });

module.exports = { syncMSYtoEcwid };
