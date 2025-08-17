// ----- GLOBAL ERROR HANDLING -----
process.on('unhandledRejection', (reason, p) => {
  console.error('[SYNC][GLOBAL] Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', err => {
  console.error('[SYNC][GLOBAL] Uncaught Exception thrown:', err);
});

// ----- IMPORT & CONFIG -----
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

// ----- SLEEP/WAIT FUNCTION -----
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ----- MSY LISTINO FETCH + LOG ROBUSTO -----
async function fetchMSYListino() {
  try {
    const start = Date.now();
    console.log('[MSY FETCH] Inizio fetch listino MSY');
    const response = await fetch('https://msy.madtec.be/price_list/pricelist_en.json');
    if (!response.ok) throw new Error(`[MSY FETCH] Errore fetch listino MSY - Status: ${response.status} ${response.statusText}`);
    const data = await response.json();
    console.log(`[MSY FETCH] Download listino completato in ${(Date.now() - start) / 1000}s`);

    if (!data || !Array.isArray(data.price_list)) {
      console.error("[MSY FETCH] Errore: risposta JSON non contiene 'price_list' valido", data);
      throw new Error("[MSY FETCH] Formato listino non valido");
    }
    console.log(`[MSY FETCH] Listino MSY scaricato e validato: ${data.price_list.length} prodotti`);
    return data.price_list;
  } catch (error) {
    console.error('[MSY FETCH] Errore fetchMSYListino:', error.message);
    throw error;
  }
}

// ----- FUNZIONE PER NORMALIZZARE IL PRODOTTO -----
function normalizzaProdotto(item) {
  return {
    sku: item.SKU,
    name: item.name,
    price: item.price,
    images: item.images,
    quantity: item.stock,
    // ... altri campi necessari per Ecwid
  };
}

// ----- INTEGRAZIONE API ECWID CON RATE LIMIT HANDLING -----
async function syncProdottoToEcwid(prodotto) {
  const apiBase = `https://app.ecwid.com/api/v3/${process.env.ECWID_STORE_ID}/products`;
  const optionsAuth = {
    headers: {
      Authorization: `Bearer ${process.env.ECWID_SECRET_TOKEN}`,
      'Content-Type': 'application/json',
    }
  };
  const sku = prodotto.sku;

  let retries = 0;
  const maxRetries = 5;
  while (retries <= maxRetries) {
    try {
      const checkResp = await fetch(`${apiBase}?sku=${encodeURIComponent(sku)}`, optionsAuth);
      const checkData = await checkResp.json();

      if (checkData && checkData.items && checkData.items.length > 0) {
        const prodId = checkData.items[0].id;
        console.log(`[ECWID SYNC] Aggiorno prodotto id=${prodId}, SKU=${sku}`);
        await fetch(`${apiBase}/${prodId}`, {
          ...optionsAuth,
          method: "PUT",
          body: JSON.stringify(prodotto)
        });
      } else {
        console.log(`[ECWID SYNC] Creo nuovo prodotto SKU=${sku}`);
        await fetch(apiBase, {
          ...optionsAuth,
          method: "POST",
          body: JSON.stringify(prodotto)
        });
      }
      return { success: true, sku };
    } catch (err) {
      // Rate limit o errore di rete
      if (err.message && err.message.includes('429')) {
        const pause = Math.min(30000, 2000 * Math.pow(2, retries));
        console.warn(`[SYNC][RATE LIMIT] Errore 429, retry n°${retries+1}, pausa ${pause/1000}s`);
        await sleep(pause);
        retries++;
        continue;
      }
      console.error(`[ECWID SYNC] Errore sync prodotto SKU ${sku}:`, err);
      return { success: false, sku, error: err.message || String(err) };
    }
  }
  return { success: false, sku, error: "[SYNC] Numero massimo di retry Ecwid raggiunto" };
}

// ----- BATCH PROCESSING + LOGGING AVANZATO -----
async function processBatch(listino) {
  const BATCH = 50;
  let total = listino.length;
  let count = 0;
  const risultati = [];
  for (let i = 0; i < total; i += BATCH) {
    const batch = listino.slice(i, i + BATCH);

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      if (!item) continue;
      try {
        const prodotto = normalizzaProdotto(item);
        const esito = await syncProdottoToEcwid(prodotto);
        risultati.push(esito);
      } catch (e) {
        console.error(`[SYNC] Errore su prodotto #${i + j}:`, e);
        risultati.push({ success: false, index: i + j, error: e.message });
      }
      count++;
      if (count % 10 === 0) {
        console.log(`[SYNC] Processati ${count}/${total} prodotti`);
      }
    }
    console.log(`[SYNC] Batch da ${i + 1} a ${Math.min(i + BATCH, total)} processato`);
  }
  return risultati;
}

// ----- TIMEOUT WRAPPER -----
async function syncMSYWithTimeout(listino, processBatch) {
  const TIMEOUT_MS = 10 * 60 * 1000; // 10 minuti
  let completed = false;
  return Promise.race([
    (async () => {
      try {
        const risultati = await processBatch(listino);
        completed = true;
        return risultati;
      } catch (e) {
        completed = true;
        throw e;
      }
    })(),
    sleep(TIMEOUT_MS).then(() => {
      if (!completed) {
        throw new Error('[SYNC] TIMEOUT RAGGIUNTO');
      }
    })
  ]);
}

// ----- ROUTE: SYNC MANUALE + LOGGING -----
app.post('/sync/msy-to-ecwid', async (req, res) => {
  const start = Date.now();
  try {
    const listino = await fetchMSYListino();
    const risultati = await syncMSYWithTimeout(listino, processBatch);
    console.log(`[SYNC] COMPLETATA! Processati ${risultati.length} prodotti in ${(Date.now() - start) / 1000}s`);
    res.json({ success: true, total: risultati.length, risultati });
  } catch (error) {
    console.error('[SYNC] Errore generale nella routine:', error);
    res.status(500).json({ error: error.message });
  }
});

// ----- ALTRE ROUTE E AVVIO SERVER -----
app.get('/health', (req, res) => res.json({ status: 'OK', now: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server MSY→Ecwid pronto su http://localhost:${PORT}`)
);

// ----- AVVIO SCHEDULER AUTOMATICO (OGNI ORA O CRON) -----
setInterval(async () => {
  try {
    await fetch(`http://localhost:${PORT}/sync/msy-to-ecwid`, { method: 'POST' });
    console.log('[SYNC][SCHEDULER] Ciclo automatico sync avviato.');
  } catch (e) {
    console.error('[SYNC][SCHEDULER] Errore scheduler:', e);
  }
}, 1000 * 60 * 60); // ogni ora
