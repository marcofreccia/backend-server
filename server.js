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

// ----- MIDDLEWARE LOGGING GLOBALE -----
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Variabili d'ambiente (configurale in .env)
const ECWID_STORE_ID = process.env.ECWID_STORE_ID;
const ECWID_TOKEN = process.env.ECWID_SECRET_TOKEN;
const MSY_URL = 'https://msy.madtec.be/price_list/pricelist_en.json';

// Helper per chiamate Ecwid API
const ecwidFetch = (endpoint, options = {}) =>
  fetch(`https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${ECWID_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  }).then(res => res.json());

// Log robusto
const log = (...args) => console.log(new Date().toISOString(), ...args);

// Funzione di sync e gestione prodotti (con batch paralleli)
async function processProduct(prodotto, i) {
  try {
    // Se manca uno SKU, genera uno fittizio unico
    const sku = prodotto.article_num && String(prodotto.article_num).trim()
      ? String(prodotto.article_num).trim()
      : `NO-SKU-${i}`;
    // Cerca per SKU (anche virtuale)
    let found = null;
    try {
      const searchRes = await ecwidFetch(`products?sku=${encodeURIComponent(sku)}`);
      found = searchRes && Array.isArray(searchRes.items) && searchRes.items[0];
    } catch (err) {
      log(`[${i}] Errore ricerca Ecwid SKU ${sku}:`, err);
    }
    // Mappa dati da MSY verso Ecwid
    const ecwidProd = {
      sku,
      name: prodotto.name || sku,
      price: Number(prodotto.price) || 0,
      quantity: prodotto.stock != null ? Number(prodotto.stock) : 0,
      // Puoi aggiungere altre proprietà Ecwid qui, esempio immagini/descriptions
    };
    if (found) {
      await ecwidFetch(`products/${found.id}`, {
        method: 'PUT',
        body: JSON.stringify(ecwidProd),
      });
      log(`[${i}] ${sku}: Aggiornato Ecwid (${found.id})`);
      return 'updated';
    } else {
      await ecwidFetch(`products`, {
        method: 'POST',
        body: JSON.stringify(ecwidProd),
      });
      log(`[${i}] ${sku}: Creato su Ecwid`);
      return 'created';
    }
  } catch (err) {
    log(`[${i}] Errore generale su prodotto:`, err.message || err);
    return 'error';
  }
}

// ----> BATCH PROCESSOR: gestisce fino a 10 prodotti in parallelo
async function syncMSYtoEcwid() {
  log('Inizio sync MSY-Ecwid...');
  const listinoResp = await fetch(MSY_URL);
  if (!listinoResp.ok) throw new Error(`MSY download HTTP ${listinoResp.status}`);
  const listino = await listinoResp.json();
  if (!listino || !Array.isArray(listino.price_list)) throw new Error('price_list non valido!');
  log(`Listino MSY scaricato: ${listino.price_list.length} prodotti`);

  let countCreated = 0, countUpdated = 0, countError = 0;
  const BATCH_SIZE = 10;
  for (let i = 0; i < listino.price_list.length; i += BATCH_SIZE) {
    const batch = listino.price_list.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((prod, idx) =>
      processProduct(prod, i + idx)
    ));
    countCreated += results.filter(r => r === 'created').length;
    countUpdated += results.filter(r => r === 'updated').length;
    countError += results.filter(r => r === 'error').length;
    log(`Progresso: ${Math.min(i + BATCH_SIZE, listino.price_list.length)}/${listino.price_list.length}`);
    // Aggiungi pausa breve se ricevi rate limit da Ecwid (es: await new Promise(r => setTimeout(r,200));)
  }
  log(`Sync COMPLETA Ecwid: ${countCreated} creati, ${countUpdated} aggiornati, ${countError} errori`);
  return { created: countCreated, updated: countUpdated, error: countError };
}

// = ROUTE SICURA PER SYNC =
app.post('/v1/ecwid-sync', async (req, res) => {
  try {
    const risultato = await syncMSYtoEcwid();
    res.status(200).json({ success: true, ...risultato });
  } catch (err) {
    log('Errore in /v1/ecwid-sync:', err.message || err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----- AVVIO SERVER -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Server in ascolto sulla porta ${PORT}`);
});

// ----- EXPORT (per test o altro) -----
module.exports = { syncMSYtoEcwid };
