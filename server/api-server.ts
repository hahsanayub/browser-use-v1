import express from 'express';
import 'dotenv/config';
import { main as extractTicketsAPI } from './openapi';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Other middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes base path
const apiRouter = express.Router();

// Extract API documentation endpoint
apiRouter.post('/extract/tickets', async (req, res) => {
  try {
    const { userRequest } = req.body;

    console.log('Starting tickets API extraction...');
    console.log('User Request:', userRequest || 'Using default request');

    const result = await extractTicketsAPI(userRequest);

    res.json({
      success: true,
      message: 'Tickets API extraction completed successfully',
      data: result,
      parameters: {
        userRequest: userRequest || 'Default tickets extraction request'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error extracting tickets API:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to extract tickets API',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Register API routes
app.use('/api', apiRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);

  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: err.message,
    timestamp: new Date().toISOString()
  });
});

// Start server
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1].endsWith('api-server.ts')) {
  app.listen(PORT, () => {
    console.log(`🚀 API Server is running on port ${PORT}`);
    console.log(`📖 Health check: http://localhost:${PORT}/health`);
    console.log(`🎫 Extract tickets: POST http://localhost:${PORT}/api/extract/tickets`);
  });
}

export default app;
export { app };
