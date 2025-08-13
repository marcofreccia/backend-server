// Import required modules
const express = require('express');
const cors = require('cors');
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
    version: '1.0.0',
    timestamp: new Date().toISOString()
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
app.get('/api/products/sku/:sku', (req, res) => {
  const { sku } = req.params;
  
  // Mock product data for demonstration
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
    data: mockProduct
  });
});

// API routes placeholder
app.get('/api', (req, res) => {
  res.json({
    message: 'API endpoint',
    endpoints: [
      'GET /',
      'GET /health',
      'GET /api',
      'GET /api/health',
      'GET /api/products/sku/:sku'
    ]
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
});
