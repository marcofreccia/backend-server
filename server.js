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

// ----- FUNZIONE FETCH + PARSING MSY CON CONTROLLI ROBUSTI -----
async function fetchMSYListino() {
  try {
    console.log('[MSY FETCH] Inizio fetch listino MSY');
    const response = await fetch('https://msy.madtec.be/price_list/pricelist_en.json');
    
    if (!response.ok) {
      throw new Error(`Errore fetch listino MSY - Status: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log('[MSY FETCH] Risposta ricevuta, tipo:', typeof data, 'keys:', Object.keys(data || {}));
    
    // Controlli robusti per validare la struttura
    if (!data) {
      throw new Error('Risposta MSY vuota o null');
    }
    
    if (typeof data !== 'object') {
      throw new Error(`Tipo di dato inaspettato: ${typeof data}, previsto object`);
    }
    
    // Verifica presenza di price_list
    if (!data.price_list) {
      console.log('[MSY FETCH] Campo price_list non trovato. Campi disponibili:', Object.keys(data));
      throw new Error('Campo price_list non trovato nella risposta MSY');
    }
    
    if (!Array.isArray(data.price_list)) {
      throw new Error(`price_list non è un array: ${typeof data.price_list}`);
    }
    
    const listino = data.price_list;
    console.log('[MSY FETCH] Listino MSY scaricato e validato:', listino.length, 'prodotti');
    
    // Log di debug per i primi elementi
    if (listino.length > 0) {
      console.log('[MSY FETCH] Esempio primo prodotto:', JSON.stringify(listino[0], null, 2));
      if (listino.length > 1) {
        console.log('[MSY FETCH] Esempio secondo prodotto:', JSON.stringify(listino[1], null, 2));
      }
    } else {
      console.warn('[MSY FETCH] ATTENZIONE: Listino vuoto!');
    }
    
    return listino;
  } catch (error) {
    console.error('[MSY FETCH] Errore fetchMSYListino:', error.message);
    console.error('[MSY FETCH] Stack trace:', error.stack);
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
      console.log(`[ECWID SYNC] Aggiorno prodotto id=${prodId}, SKU=${sku}`);
      await fetch(`${apiBase}/${prodId}`, {
        ...optionsAuth,
        method: "PUT",
        body: JSON.stringify(prodotto)
      });
    } else {
      // Create via POST
      console.log(`[ECWID SYNC] Creo nuovo prodotto SKU=${sku}`);
      await fetch(apiBase, {
        ...optionsAuth,
        method: "POST",
        body: JSON.stringify(prodotto)
      });
    }
    
    return { success: true, sku };
  } catch (err) {
    console.error(`[ECWID SYNC] Errore sync prodotto SKU ${sku}:`, err);
    return { success: false, sku, error: err.message || String(err) };
  }
}

// ----- ROUTE: SYNC MANUALE & LOGGING -----
app.post('/sync/msy-to-ecwid', async (req, res) => {
  try {
    console.log('[SYNC] = SYNC MSY → ECWID AVVIATA =');
    const listino = await fetchMSYListino();
    
    console.log(`[SYNC] Inizio iterazione su ${listino.length} prodotti`);
    const risultati = [];
    
    // Iterazione robusta con controlli su ogni elemento
    for (let i = 0; i < listino.length; i++) {
      const item = listino[i];
      
      if (!item) {
        console.warn(`[SYNC] Prodotto ${i} è null/undefined, skip`);
        continue;
      }
      
      try {
        const prodotto = normalizzaProdotto(item);
        const esito = await syncProdottoToEcwid(prodotto);
        risultati.push(esito);
        
        if ((i + 1) % 10 === 0) {
          console.log(`[SYNC] Processati ${i + 1}/${listino.length} prodotti`);
        }
      } catch (itemError) {
        console.error(`[SYNC] Errore processando prodotto ${i}:`, itemError);
        risultati.push({ success: false, index: i, error: itemError.message });
      }
    }
    
    const successCount = risultati.filter(r => r.success).length;
    const errorCount = risultati.filter(r => !r.success).length;
    
    console.log(`[SYNC] = SYNC COMPLETATA = Total: ${risultati.length}, Success: ${successCount}, Errors: ${errorCount}`);
    res.json({ success: true, total: risultati.length, successCount, errorCount, risultati });
    
  } catch (error) {
    console.error('[SYNC] Errore in /sync/msy-to-ecwid:', error);
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

// ----- SCHEDULER AUTOMATICO ATTIVO -----
setInterval(async () => {
  try {
    await fetch('http://localhost:' + PORT + '/sync/msy-to-ecwid', { method: 'POST' });
    console.log('Ciclo automatico sync avviato.');
  } catch (e) {
    console.error('Errore scheduler:', e);
  }
}, 1000 * 60 * 60); // ogni ora
