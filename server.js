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
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Product API routes
app.get('/api/products/sku/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    console.log(`🔍 Searching for product with SKU: ${sku}`);
    
    const response = await fetch('http://msy.madtec.be/price_list/pricelist_en.json');
    const data = await response.json();
    
    const product = data.find(item => item.sku && item.sku.toLowerCase() === sku.toLowerCase());
    
    if (product) {
      console.log(`✅ Product found: ${product.name}`);
      res.json({
        success: true,
        product: product,
        source: 'MSY Price List'
      });
    } else {
      console.log(`❌ Product not found for SKU: ${sku}`);
      res.status(404).json({
        success: false,
        message: 'Product not found',
        sku: sku
      });
    }
    
  } catch (error) {
    console.error('❌ Error fetching product data:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product data',
      error: error.message
    });
  }
});

// MSY Integration Routes
app.get('/sync/preview', async (req, res) => {
  try {
    console.log('🔄 Fetching MSY price list preview...');
    
    const response = await fetch('http://msy.madtec.be/price_list/pricelist_en.json');
    const data = await response.json();
    
    // Get first 10 items as preview
    const preview = data.slice(0, 10).map(item => ({
      sku: item.sku,
      name: item.name,
      price: item.price,
      category: item.category,
      subcategory: item.subcategory,
      availability: item.availability
    }));
    
    console.log(`✅ Retrieved ${preview.length} items from MSY`);
    
    res.json({
      success: true,
      message: 'MSY price list preview',
      total_items: data.length,
      preview: preview,
      source: 'http://msy.madtec.be/price_list/pricelist_en.json',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error fetching MSY data:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching MSY data',
      error: error.message
    });
  }
});

app.post('/sync/msy-to-ecwid', async (req, res) => {
  try {
    console.log('🚀 Starting MSY to Ecwid sync...');
    
    // Fetch MSY data
    const msyResponse = await fetch('http://msy.madtec.be/price_list/pricelist_en.json');
    const msyData = await msyResponse.json();
    
    console.log(`📦 Retrieved ${msyData.length} products from MSY`);
    
    // This is where you would implement the actual Ecwid sync
    // For now, we'll just return a summary
    
    const productSummary = {
      totalProducts: msyData.length,
      categories: [...new Set(msyData.map(item => item.category))],
      sampleProducts: msyData.slice(0, 5).map(item => ({
        sku: item.sku,
        name: item.name,
        price: item.price
      }))
    };
    
    res.json({
      success: true,
      message: 'MSY data retrieved successfully',
      summary: productSummary,
      timestamp: new Date().toISOString(),
      note: 'Ecwid integration not yet implemented'
    });
    
  } catch (error) {
    console.error('❌ Error during MSY sync:', error);
    res.status(500).json({
      success: false,
      message: 'Error during MSY sync',
      error: error.message
    });
  }
});

// Helper function to create category structure
function createCategoryStructure(products) {
  const categories = new Map();
  
  products.forEach(product => {
    const mainCat = product.category;
    const subcat = product.subcategory;
    
    if (!categories.has(mainCat)) {
      categories.set(mainCat, {
        name: mainCat,
        description: `Main category: ${mainCat}`,
        subcategories: new Set()
      });
    }
    
    if (subcat) {
      categories.get(mainCat).subcategories.add(subcat);
    }
  });
  
  // Convert to array format suitable for Ecwid
  const categoriesArray = [];
  
  categories.forEach((catData, catName) => {
    // Add main category
    categoriesArray.push({
      name: catName,
      description: catData.description
    });
    
    // Add subcategories
    catData.subcategories.forEach(subcat => 
      categoriesArray.push({
        name: subcat,
        parentId: 176669407, // This would be dynamic in real implementation
        description: `Subcategory: ${subcat}`
      })
    )
  };
  
  return categories;
}

// API routes placeholder
app.get('/api', (req, res) => {
  res.json({
    message: 'API endpoint',
    version: '2.0.0',
    endpoints: [
      'GET /',
      'GET /health',
      'GET /api',
      'GET /api/health',
      'GET /api/products/sku/:sku',
      'GET /sync/preview',
      'POST /sync/msy-to-ecwid'
    ],
    description: 'Backend server with MSY integration for Ecwid e-commerce platform'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Something went wrong!',
    message: err.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    requestedUrl: req.originalUrl
  });
});

// Start server with host 0.0.0.0 for Railway compatibility
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is listening on port ${PORT} (process.env.PORT: ${process.env.PORT || 'not set'})`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 http://0.0.0.0:${PORT}`);
  console.log(`💚 Health check available at /health`);
  console.log(`🛒 Product API available at /api/products/sku/:sku`);
  console.log(`🔄 MSY Preview available at /sync/preview`);
  console.log(`⚡ MSY Sync available at POST /sync/msy-to-ecwid`);
  console.log(`📊 MSY Integration: http://msy.madtec.be/price_list/pricelist_en.json`);
});
