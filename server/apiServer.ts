import express from 'express';
import 'dotenv/config';
import fileRoutes from './fileRoute';
import browserUseRoutes from './browserUseRoute';

const app = express();
const PORT = process.env.PORT || 8000;

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

apiRouter.use('/filesystem', fileRoutes);
apiRouter.use('/browser-use', browserUseRoutes);

// Register API routes
app.use('/api/v1', apiRouter);

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
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1].endsWith('apiServer.ts')) {
  app.listen(PORT, () => {
    console.log(`🚀 API Server is running on port ${PORT}`);
    console.log(`📖 Health check: http://localhost:${PORT}/health`);
    console.log(`🌊 Browser-use SSE: POST http://localhost:${PORT}/api/v1/browser-use/sse`);
    console.log(`📊 Browser-use status: GET http://localhost:${PORT}/api/v1/browser-use/status`);
    console.log(`❌ Browser-use cancel: POST http://localhost:${PORT}/api/v1/browser-use/cancel`);
    console.log(`📋 Browser-use sessions: GET http://localhost:${PORT}/api/v1/browser-use/sessions`);
    console.log(`📁 Download file: GET http://localhost:${PORT}/api/v1/filesystem/download?file=<filepath>&sessionId=<sessionId>`);
    console.log(`📂 List files: GET http://localhost:${PORT}/api/v1/filesystem/files/list?projectId=<projectId>&directory=<directory>`);
  });
}

export default app;
export { app };
