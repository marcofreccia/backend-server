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
const cors = require('cors');
const app = express();
app.use(express.json());

// ----- CORS GLOBALE -----
app.use(cors({
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type, Authorization, X-API-Key',
}));

// ----- MIDDLEWARE LOGGING GLOBALE -----
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ----- MIDDLEWARE PER RICHIESTE ABORTITE/CHIUSE DAL CLIENT -----
app.use((req, res, next) => {
  req.on('aborted', () => {
    console.warn(`[ABORTED] La richiesta del client è stata chiusa prima della risposta: ${req.method} ${req.url}`);
  });
  next();
});

// ----- MIDDLEWARE GLOBALE DI ERRORE PER ABORT O ALTRO -----
app.use((err, req, res, next) => {
  if (err && (err.name === 'BadRequestError' || err.message === 'request aborted')) {
    console.warn('Caught aborted request:', err);
    return res.status(499).send('Client Closed Request');
  }
  next(err);
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

// Funzione di sync in batch paralleli
async function processProduct(prodotto, i) {
  try {
    const sku = prodotto.article_num && String(prodotto.article_num).trim()
      ? String(prodotto.article_num).trim()
      : `NO-SKU-${i}`;
    let found = null;
    try {
      const searchRes = await ecwidFetch(`products?sku=${encodeURIComponent(sku)}`);
      found = searchRes && Array.isArray(searchRes.items) && searchRes.items[0];
    } catch (err) {
      log(`[${i}] Errore ricerca Ecwid SKU ${sku}:`, err);
    }
    const ecwidProd = {
      sku,
      name: prodotto.name || sku,
      price: Number(prodotto.price) || 0,
      quantity: prodotto.stock != null ? Number(prodotto.stock) : 0,
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
  }
  log(`Sync COMPLETA Ecwid: ${countCreated} creati, ${countUpdated} aggiornati, ${countError} errori`);
  return { created: countCreated, updated: countUpdated, error: countError };
}

app.post('/v1/ecwid-sync', async (req, res) => {
  try {
    const risultato = await syncMSYtoEcwid();
    res.status(200).json({ success: true, ...risultato });
  } catch (err) {
    log('Errore in /v1/ecwid-sync:', err.message || err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const server = app.listen(process.env.PORT || 3000, () => {
  log(`Server in ascolto sulla porta ${process.env.PORT || 3000}`);
});

// Timeout HTTP del server esplicitato (2 minuti = 120000 ms)
server.setTimeout(120000);

module.exports = { syncMSYtoEcwid };
