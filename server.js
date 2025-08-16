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

// ----- CHECK VARIABILI AMBIENTE -----
const { ECWID_STORE_ID, ECWID_SECRET_TOKEN } = process.env;
if (!ECWID_STORE_ID || !ECWID_SECRET_TOKEN) {
  throw new Error('Missing Ecwid environment variables');
}

// ----- FUNZIONE FETCH + PARSING MSY -----
async function fetchMSYListino() {
  try {
    console.log('Inizio fetch listino MSY');
    const response = await fetch('https://msy.madtec.be/price_list/pricelist_en.json');
    if (!response.ok) throw new Error('Errore fetch listino MSY');
    const listino = await response.json();
    console.log('Listino MSY scaricato e parsato:', listino.length, 'prodotti');
    return listino;
  } catch (error) {
    console.error('Errore fetchMSYListino:', error);
    throw error;
  }
}

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

// ----- INTEGRAZIONE API ECWID -----
async function syncProdottoToEcwid(prodotto) {
  const apiBase = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/products`;
  const optionsAuth = { headers: { Authorization: `Bearer ${ECWID_SECRET_TOKEN}`, 'Content-Type': 'application/json' } };
  const sku = prodotto.sku;
  try {
    const checkResp = await fetch(`${apiBase}?sku=${encodeURIComponent(sku)}`, optionsAuth);
    const checkData = await checkResp.json();
    if (checkData && checkData.items && checkData.items.length > 0) {
      // Update via PUT/PATCH
      const prodId = checkData.items[0].id;
      console.log(`Aggiorno prodotto Ecwid id=${prodId}, SKU=${sku}`);
      await fetch(`${apiBase}/${prodId}`, {
        ...optionsAuth,
        method: "PUT",
        body: JSON.stringify(prodotto)
      });
    } else {
      // Create via POST
      console.log(`Creo nuovo prodotto Ecwid SKU=${sku}`);
      await fetch(apiBase, {
        ...optionsAuth,
        method: "POST",
        body: JSON.stringify(prodotto)
      });
    }
    return { success: true, sku };
  } catch (err) {
    console.error(`Errore sync prodotto SKU ${sku}:`, err);
    return { success: false, sku, error: err.message || String(err) };
  }
}

// ----- ROUTE: SYNC MANUALE & LOGGING -----
app.post('/sync/msy-to-ecwid', async (req, res) => {
  try {
    console.log('= SYNC MSY → ECWID AVVIATA =');
    const listino = await fetchMSYListino();
    const risultati = [];
    for (const item of listino) {
      const prodotto = normalizzaProdotto(item);
      const esito = await syncProdottoToEcwid(prodotto);
      risultati.push(esito);
    }
    console.log('= SYNC COMPLETATA =', risultati.length, 'prodotti sincronizzati');
    res.json({ success: true, risultati });
  } catch (error) {
    console.error('Errore in /sync/msy-to-ecwid:', error);
    res.status(500).json({ error: error.message || 'Errore generico nella sync' });
  }
});

// ----- ROUTE DI TEST, HEALTH, DIAGNOSTICA -----
app.get('/health', (req, res) => res.json({ status: 'OK', now: new Date() }));

app.get('/api/products/sku/:sku', async (req, res) => {
  try {
    const sku = req.params.sku;
    console.log('Verifica presenza prodotto Ecwid SKU:', sku);
    const apiBase = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/products`;
    const optionsAuth = { headers: { Authorization: `Bearer ${ECWID_SECRET_TOKEN}` } };
    const checkResp = await fetch(`${apiBase}?sku=${encodeURIComponent(sku)}`, optionsAuth);
    const checkData = await checkResp.json();
    res.json(checkData);
  } catch (err) {
    console.error('Errore in /api/products/sku/:sku:', err);
    res.status(500).json({ error: err.message || 'Errore generico' });
  }
});

// ----- CATCH GLOBALE -----
app.use((err, req, res, next) => {
  console.error('CATCH GLOBALE:', err);
  res.status(500).json({ error: 'Errore server', detail: err.message });
});

// ----- AVVIO SERVER -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server MSY→Ecwid pronto su http://localhost:${PORT}`)
);

// ----- (OPZIONALE) SCHEDULER AUTOMATICO -----
/*
setInterval(async () => {
  try {
    await fetch('http://localhost:' + PORT + '/sync/msy-to-ecwid', { method: 'POST' });
    console.log('Ciclo automatico sync avviato.');
  } catch (e) {
    console.error('Errore scheduler:', e);
  }
}, 1000 * 60 * 60); // ogni ora
*/
