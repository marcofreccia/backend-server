// Global error handling
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

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

// API health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Helper function to fetch from MSY API
async function fetchFromMSY(endpoint, options = {}) {
  const baseUrl = 'https://api.msy.com.au';
  const url = `${baseUrl}${endpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  // Only add Authorization header if MSY_API_KEY is present and not empty
  if (process.env.MSY_API_KEY && process.env.MSY_API_KEY.trim() !== '') {
    headers['Authorization'] = `Bearer ${process.env.MSY_API_KEY}`;
  }

  const requestOptions = {
    method: options.method || 'GET',
    headers,
    ...options
  };

  try {
    const response = await fetch(url, requestOptions);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`MSY API error: ${response.status} - ${data.message || 'Unknown error'}`);
    }
    
    return data;
  } catch (error) {
    // Only log error if it's not about missing API key for public endpoints
    if (!error.message.includes('401') || (process.env.MSY_API_KEY && process.env.MSY_API_KEY.trim() !== '')) {
      console.error('Critical error', error);
    }
    throw error;
  }
}

// Helper function to fetch from Ecwid API
async function fetchFromEcwid(endpoint, options = {}) {
  const storeId = process.env.ECWID_STORE_ID;
  const token = process.env.ECWID_SECRET_TOKEN;
  
  if (!storeId || !token) {
    throw new Error('Ecwid credentials not configured');
  }

  const baseUrl = `https://app.ecwid.com/api/v3/${storeId}`;
  const url = `${baseUrl}${endpoint}`;
  
  const requestOptions = {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  };

  try {
    const response = await fetch(url, requestOptions);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Ecwid API error: ${response.status} - ${data.errorMessage || 'Unknown error'}`);
    }
    
    return data;
  } catch (error) {
    console.error('Critical error', error);
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

    const product = await fetchFromMSY(`/products/sku/${sku}`);
    res.json(product);
  } catch (error) {
    console.error('Critical error', error);
    res.status(500).json({ error: error.message });
  }
});

// Preview sync - show what would be synced without actually syncing
app.get('/sync/preview', async (req, res) => {
  try {
    // Fetch products from MSY
    const msyProducts = await fetchFromMSY('/products');
    
    if (!msyProducts || !msyProducts.data) {
      return res.status(404).json({ error: 'No products found in MSY' });
    }

    // Preview data
    const preview = {
      total_products: msyProducts.data.length,
      products: msyProducts.data.map(product => ({
        sku: product.sku,
        name: product.name,
        price: product.price,
        stock: product.stock,
        category: product.category
      })),
      timestamp: new Date().toISOString()
    };

    res.json(preview);
  } catch (error) {
    console.error('Critical error', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync products from MSY to Ecwid
app.post('/sync/msy-to-ecwid', async (req, res) => {
  try {
    // Fetch products from MSY
    const msyProducts = await fetchFromMSY('/products');
    
    if (!msyProducts || !msyProducts.data) {
      return res.status(404).json({ error: 'No products found in MSY' });
    }

    const syncResults = [];
    
    // Process each product
    for (const msyProduct of msyProducts.data) {
      try {
        // Check if product exists in Ecwid
        let ecwidProduct;
        try {
          const existingProducts = await fetchFromEcwid(`/products?sku=${msyProduct.sku}`);
          ecwidProduct = existingProducts.items && existingProducts.items.length > 0 ? existingProducts.items[0] : null;
        } catch (error) {
          // Product doesn't exist, will create new one
          ecwidProduct = null;
        }

        const productData = {
          sku: msyProduct.sku,
          name: msyProduct.name,
          price: msyProduct.price,
          description: msyProduct.description,
          enabled: true,
          quantity: msyProduct.stock || 0,
          categories: msyProduct.category ? [{ id: msyProduct.category }] : []
        };

        let result;
        if (ecwidProduct) {
          // Update existing product
          result = await fetchFromEcwid(`/products/${ecwidProduct.id}`, {
            method: 'PUT',
            body: JSON.stringify(productData)
          });
          syncResults.push({
            sku: msyProduct.sku,
            action: 'updated',
            success: true,
            ecwid_id: ecwidProduct.id
          });
        } else {
          // Create new product
          result = await fetchFromEcwid('/products', {
            method: 'POST',
            body: JSON.stringify(productData)
          });
          syncResults.push({
            sku: msyProduct.sku,
            action: 'created',
            success: true,
            ecwid_id: result.id
          });
        }
      } catch (productError) {
        console.error('Critical error', productError);
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
    console.error('Critical error', error);
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Critical error', err);
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
  const requiredEnvVars = ['ECWID_STORE_ID', 'ECWID_SECRET_TOKEN'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.warn('Warning: Missing environment variables:', missingVars.join(', '));
  } else {
    console.log('All required environment variables are set');
  }
  
  // MSY_API_KEY is now optional for public endpoints
  if (!process.env.MSY_API_KEY || process.env.MSY_API_KEY.trim() === '') {
    console.log('MSY_API_KEY not set - will work for public endpoints only');
  } else {
    console.log('MSY_API_KEY is configured');
  }
});
