// Import required modules
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic routes
app.get('/', (req, res) => {
  res.json({
    message: 'Backend Server is running!',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /',
      'GET /health',
      'GET /api',
      'GET /api/health',
      'GET /api/products/sku/:sku',
      'GET /sync/preview',
      'POST /sync/msy-to-ecwid'
    ]
  });
});

// Health check routes
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API base route
app.get('/api', (req, res) => {
  res.json({
    message: 'API is running!',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// API health route
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    api_version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// MSY API configuration
const MSY_BASE_URL = 'https://api.msy.com.au';
const MSY_API_KEY = process.env.MSY_API_KEY;
const ECWID_STORE_ID = process.env.ECWID_STORE_ID;
const ECWID_SECRET_TOKEN = process.env.ECWID_SECRET_TOKEN;
const ECWID_PUBLIC_TOKEN = process.env.ECWID_PUBLIC_TOKEN;

// Helper function to make MSY API calls
async function msyApiCall(endpoint, options = {}) {
  try {
    const url = `${MSY_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${MSY_API_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });
    
    if (!response.ok) {
      throw new Error(`MSY API Error: ${response.status} - ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('MSY API Call Error:', error);
    throw error;
  }
}

// Helper function to make Ecwid API calls
async function ecwidApiCall(endpoint, options = {}) {
  try {
    const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${ECWID_SECRET_TOKEN}`,
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });
    
    if (!response.ok) {
      throw new Error(`Ecwid API Error: ${response.status} - ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Ecwid API Call Error:', error);
    throw error;
  }
}

// Get product by SKU from MSY
app.get('/api/products/sku/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    
    if (!sku) {
      return res.status(400).json({ error: 'SKU is required' });
    }
    
    const product = await msyApiCall(`/products/sku/${sku}`);
    res.json(product);
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ error: error.message });
  }
});

// Preview sync data
app.get('/sync/preview', async (req, res) => {
  try {
    // Get sample MSY products
    const msyProducts = await msyApiCall('/products?limit=10');
    
    // Get sample Ecwid products
    const ecwidProducts = await ecwidApiCall('/products?limit=10');
    
    res.json({
      message: 'Sync preview data',
      msy_products: msyProducts,
      ecwid_products: ecwidProducts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating sync preview:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync products from MSY to Ecwid
app.post('/sync/msy-to-ecwid', async (req, res) => {
  try {
    // Get all products from MSY
    const msyProducts = await msyApiCall('/products');
    
    if (!msyProducts || !Array.isArray(msyProducts.data)) {
      return res.status(400).json({ error: 'No products found from MSY API' });
    }
    
    const syncResults = [];
    
    for (const msyProduct of msyProducts.data) {
      try {
        // Check if product exists in Ecwid by SKU
        const existingProduct = await ecwidApiCall(`/products?sku=${msyProduct.sku}`);
        
        // Transform MSY product data to Ecwid format
        const ecwidProductData = {
          name: msyProduct.name,
          description: msyProduct.description || '',
          sku: msyProduct.sku,
          price: parseFloat(msyProduct.price) || 0,
          quantity: parseInt(msyProduct.stock) || 0,
          enabled: true,
          categories: msyProduct.category ? [{ name: msyProduct.category }] : []
        };
        
        let result;
        if (existingProduct && existingProduct.items && existingProduct.items.length > 0) {
          // Update existing product
          const productId = existingProduct.items[0].id;
          result = await ecwidApiCall(`/products/${productId}`, {
            method: 'PUT',
            body: JSON.stringify(ecwidProductData)
          });
          syncResults.push({
            sku: msyProduct.sku,
            action: 'updated',
            success: true,
            productId
          });
        } else {
          // Create new product
          result = await ecwidApiCall('/products', {
            method: 'POST',
            body: JSON.stringify(ecwidProductData)
          });
          syncResults.push({
            sku: msyProduct.sku,
            action: 'created',
            success: true,
            productId: result.id
          });
        }
      } catch (productError) {
        console.error(`Error syncing product ${msyProduct.sku}:`, productError);
        syncResults.push({
          sku: msyProduct.sku,
          action: 'error',
          success: false,
          error: productError.message
        });
      }
    }
    
    const successCount = syncResults.filter(r => r.success).length;
    const errorCount = syncResults.filter(r => !r.success).length;
    
    res.json({
      message: 'Sync completed',
      total_products: msyProducts.data.length,
      successful_syncs: successCount,
      failed_syncs: errorCount,
      results: syncResults,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error during sync:', error);
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Verify environment variables
  const requiredEnvVars = ['MSY_API_KEY', 'ECWID_STORE_ID', 'ECWID_SECRET_TOKEN'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.warn('Warning: Missing environment variables:', missingVars.join(', '));
  } else {
    console.log('All required environment variables are set');
  }
});
