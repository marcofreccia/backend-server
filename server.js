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
const fetch = require('node-fetch'); // usa import('node-fetch') se ESM

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

// Funzione principale di sync
async function syncMSYtoEcwid() {
  log('Inizio sync MSY-Ecwid...');
  // 1. Scarica e valida listino
  const listinoResp = await fetch(MSY_URL);
  if (!listinoResp.ok) throw new Error(`MSY download HTTP ${listinoResp.status}`);
  const listino = await listinoResp.json();
  if (!listino || !Array.isArray(listino.price_list)) throw new Error('price_list non valido!');
  log(`Listino MSY scaricato: ${listino.price_list.length} prodotti`);

  let countCreated = 0, countUpdated = 0, countIgnored = 0, countError = 0;

  // 2. Ciclo prodotti
  for (const [i, prodotto] of listino.price_list.entries()) {
    const sku = prodotto.article_num && String(prodotto.article_num).trim();
    if (!sku) {
      countIgnored++;
      log(`[${i}] Nessun SKU, prodotto ignorato`, prodotto.name || prodotto);
      continue;
    }
    // 2a. Cerca SKU in Ecwid
    let found = null;
    try {
      const searchRes = await ecwidFetch(`products?sku=${encodeURIComponent(sku)}`);
      found = searchRes && Array.isArray(searchRes.items) && searchRes.items[0];
    } catch (err) {
      countError++;
      log(`[${i}] Errore Ecwid search SKU ${sku}:`, err);
      continue;
    }
    // 2b. Prepara struttura prodotto Ecwid
    const ecwidProd = {
      sku,
      name: prodotto.name || sku,
      price: Number(prodotto.price) || 0,
      quantity: prodotto.stock != null ? Number(prodotto.stock) : 0,
      // Puoi aggiungere immagini, descrizioni, attributi qui se richiesto
    };
    try {
      if (found) {
        // UPDATE prodotto
        await ecwidFetch(`products/${found.id}`, {
          method: 'PUT',
          body: JSON.stringify(ecwidProd),
        });
        countUpdated++;
        log(`[${i}] ${sku}: Aggiornato Ecwid (${found.id})`);
      } else {
        // CREA nuovo prodotto
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

// ===== ROUTE SICURA PER SYNC =====
// = ROUTE SICURA PER SYNC =
app.post('/v1/ecwid-sync', async (req, res) => {
  try {
    const risultato = await syncMSYtoEcwid();
    res.status(200).json({ success: true, ...risultato });
  } catch (err) {
    // Logging error sul server e ritorno JSON di errore
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
