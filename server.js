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
  const { sku } = req.params;
  
  try {
    // First try to get from MSY data if available
    const msyProduct = await getMSYProduct(sku);
    if (msyProduct) {
      return res.json({
        success: true,
        data: msyProduct,
        source: 'MSY'
      });
    }
    
    // Fallback to mock data
    const mockProduct = {
      sku: sku,
      name: `Product ${sku}`,
      price: Math.floor(Math.random() * 100) + 10,
      description: `This is a mock product with SKU ${sku}`,
      inStock: Math.random() > 0.5,
      category: 'General',
      timestamp: new Date().toISOString()
    };
    
    res.json({
      success: true,
      data: mockProduct,
      source: 'Mock'
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch product',
      message: error.message
    });
  }
});

// MSY Sync endpoints
app.get('/sync/preview', async (req, res) => {
  try {
    console.log('Fetching MSY preview data...');
    const msyData = await fetchMSYData();
    
    if (!msyData || !Array.isArray(msyData)) {
      return res.status(500).json({
        success: false,
        error: 'Invalid MSY data format'
      });
    }
    
    const preview = {
      totalProducts: msyData.length,
      sampleProducts: msyData.slice(0, 10).map(product => ({
        sku: product.ean || product.article_num || 'N/A',
        name: product.name || 'Unknown Product',
        brand: product.brand || 'Unknown Brand',
        originalPrice: product.price || 0,
        calculatedPrice: calculatePrice(product.price || 0),
        category: product.scat || 'Uncategorized',
        supplierCode: product.article_num || 'N/A',
        ean: product.ean || 'N/A',
        images: getProductImages(product)
      })),
      categoryBreakdown: getCategoryBreakdown(msyData),
      timestamp: new Date().toISOString()
    };
    
    res.json({
      success: true,
      data: preview
    });
  } catch (error) {
    console.error('Error generating preview:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate preview',
      message: error.message
    });
  }
});

app.post('/sync/msy-to-ecwid', async (req, res) => {
  try {
    console.log('Starting MSY to Ecwid sync...');
    
    // Fetch MSY data
    const msyData = await fetchMSYData();
    
    if (!msyData || !Array.isArray(msyData)) {
      return res.status(500).json({
        success: false,
        error: 'Invalid MSY data format'
      });
    }
    
    // Process products for Ecwid
    const processedProducts = [];
    const errors = [];
    
    for (const product of msyData) {
      try {
        const ecwidProduct = await convertMSYToEcwid(product);
        processedProducts.push(ecwidProduct);
      } catch (error) {
        errors.push({
          product: product.article_num || product.ean || 'Unknown',
          error: error.message
        });
      }
    }
    
    // In a real implementation, here you would:
    // 1. Create/update Ecwid categories
    // 2. Upload products to Ecwid via their API
    // 3. Handle product images
    
    const result = {
      totalProcessed: processedProducts.length,
      totalErrors: errors.length,
      categories: await createEcwidCategories(msyData),
      sampleProducts: processedProducts.slice(0, 5),
      errors: errors.slice(0, 10), // Limit error reporting
      timestamp: new Date().toISOString()
    };
    
    console.log(`Sync completed: ${result.totalProcessed} products processed, ${result.totalErrors} errors`);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('Error during MSY sync:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync MSY data to Ecwid',
      message: error.message
    });
  }
});

// Helper functions
async function fetchMSYData() {
  const response = await fetch('http://msy.madtec.be/price_list/pricelist_en.json');
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const data = await response.json();
  return data;
}

async function getMSYProduct(sku) {
  try {
    const msyData = await fetchMSYData();
    const product = msyData.find(p => p.ean === sku || p.article_num === sku);
    
    if (product) {
      return {
        sku: product.ean || product.article_num,
        name: product.name || 'Unknown Product',
        brand: product.brand || 'Unknown Brand',
        price: calculatePrice(product.price || 0),
        originalPrice: product.price || 0,
        description: product.description || `${product.brand} ${product.name}`,
        inStock: true, // Assume in stock from MSY
        category: product.scat || 'General',
        supplierCode: product.article_num,
        ean: product.ean,
        images: getProductImages(product),
        timestamp: new Date().toISOString()
      };
    }
    return null;
  } catch (error) {
    console.error('Error fetching MSY product:', error);
    return null;
  }
}

function calculatePrice(originalPrice) {
  // Price calculation: 2x + 18% VAT, ending in .00
  const doubledPrice = originalPrice * 2;
  const withVAT = doubledPrice * 1.18;
  return Math.ceil(withVAT); // This will give us whole numbers ending in .00
}

function getProductImages(product) {
  const images = [];
  for (let i = 1; i <= 5; i++) {
    const imageKey = `photo_${i}`;
    if (product[imageKey] && product[imageKey].trim()) {
      images.push(product[imageKey]);
    }
  }
  return images;
}

function getCategoryBreakdown(msyData) {
  const categories = {};
  msyData.forEach(product => {
    const category = product.scat || 'Uncategorized';
    categories[category] = (categories[category] || 0) + 1;
  });
  return categories;
}

async function convertMSYToEcwid(msyProduct) {
  return {
    sku: msyProduct.ean || msyProduct.article_num,
    name: msyProduct.name || 'Unknown Product',
    price: calculatePrice(msyProduct.price || 0),
    description: msyProduct.description || `${msyProduct.brand || 'Unknown Brand'} ${msyProduct.name || 'Product'}`,
    enabled: true,
    categoryIds: [176669407], // PRE-ORDER category ID
    defaultCategoryId: 176669407,
    attributes: [
      {
        name: 'SupplierCode',
        value: msyProduct.article_num || ''
      },
      {
        name: 'EAN',
        value: msyProduct.ean || ''
      },
      {
        name: 'Brand',
        value: msyProduct.brand || ''
      },
      {
        name: 'Subcategory',
        value: msyProduct.scat || ''
      }
    ],
    galleryImages: getProductImages(msyProduct).map(imageUrl => ({
      url: imageUrl,
      alt: msyProduct.name || 'Product Image'
    })),
    options: [],
    tax: {
      defaultLocationIncludedTaxRate: 18,
      enabledManualTaxes: []
    }
  };
}

async function createEcwidCategories(msyData) {
  // Get unique subcategories
  const subcategories = [...new Set(msyData.map(product => product.scat).filter(Boolean))];
  
  // In a real implementation, you would create these categories in Ecwid
  // For now, we'll just return the structure
  const categories = {
    parent: {
      id: 176669407,
      name: 'PRE-ORDER',
      description: 'Pre-order products from MSY'
    },
    subcategories: subcategories.map((subcat, index) => ({
      id: 176669407 + index + 1, // Mock IDs
      name: subcat,
      parentId: 176669407,
      description: `Subcategory: ${subcat}`
    }))
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
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 http://0.0.0.0:${PORT}`);
  console.log(`💚 Health check available at /health`);
  console.log(`🛒 Product API available at /api/products/sku/:sku`);
  console.log(`🔄 MSY Preview available at /sync/preview`);
  console.log(`⚡ MSY Sync available at POST /sync/msy-to-ecwid`);
  console.log(`📊 MSY Integration: http://msy.madtec.be/price_list/pricelist_en.json`);
});
