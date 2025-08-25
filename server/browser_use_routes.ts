import express from 'express';
import { BrowserUseService } from './BrowserUseService';

const router = express.Router();
const browserUseService = new BrowserUseService();


// SSE endpoint for real-time browser-use execution
router.post('/sse', async (req, res) => {
  try {
    const { user_request, maxSteps = 200, session_id } = req.body;

    console.log('Browser-use SSE: Client connected for execution');

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control, Content-Type, Accept');

    // Send event function - matching Python version format
    const sendEvent = (eventType: string, data: any) => {
      if (!res.destroyed) {
        res.write(`event: ${eventType}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Set SSE sender in service
    browserUseService.setSseSender(sendEvent);

    // Start execution
    const sessionId = await browserUseService.startSseExecution(user_request, maxSteps, session_id);

    // Handle client disconnect
    req.on('close', () => {
      console.log('Browser-use SSE: Client disconnected');
      browserUseService.clearSseSender();
      if (sessionId) {
        browserUseService.cancelSession(sessionId);
      }
    });

    req.on('error', (error) => {
      console.error('Browser-use SSE: Connection error:', error);
      browserUseService.clearSseSender();
      if (sessionId) {
        browserUseService.cancelSession(sessionId);
      }
    });
  } catch (error) {
    console.error('Error in SSE endpoint:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to start SSE browser-use execution',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }
  }
});


// Status endpoint
router.get('/status', (req, res) => {
  try {
    const result = browserUseService.getStatus();
    res.json(result);
  } catch (error) {
    console.error('Error getting status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get service status',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// Cancel session endpoint
router.post('/cancel', (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Session ID is required',
        timestamp: new Date().toISOString(),
      });
    }

    const cancelled = browserUseService.cancelSession(sessionId);

    if (cancelled) {
      res.json({
        success: true,
        message: `Session ${sessionId} cancelled successfully`,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Session ${sessionId} not found`,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error('Error cancelling session:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel session',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// Sessions endpoint
router.get('/sessions', (req, res) => {
  try {
    const activeSessions = browserUseService.getActiveSessions();

    res.json({
      success: true,
      message: 'Active sessions retrieved successfully',
      sessions: activeSessions,
      count: activeSessions.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error getting sessions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get active sessions',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
