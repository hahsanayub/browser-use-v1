import express from 'express';
import { BrowserUseService } from './browserUseService';

const router = express.Router();
const browserUseService = new BrowserUseService();


// SSE endpoint for real-time browser-use execution
router.post('/sse', async (req, res) => {
  let sessionId: string | null = null;
  let connectionClosed = false;

  // Function to safely close connection
  const closeConnection = () => {
    if (!connectionClosed && !res.destroyed) {
      connectionClosed = true;
      try {
        // Send connection close event
        res.write(`event: connection_close\n`);
        res.write(`data: ${JSON.stringify({ message: 'Connection closed', timestamp: new Date().toISOString() })}\n\n`);
        // Properly end SSE connection
        res.end();
      } catch (error) {
        console.warn('Error closing SSE connection:', error);
        // Force close connection
        res.destroy();
      }
    }
  };

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
      if (!res.destroyed && !connectionClosed) {
        try {
          res.write(`event: ${eventType}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);

          // Check if it's a completion or error event, close connection if so
          if (['agent_complete', 'session_complete', 'execution_error', 'error', 'cancelled'].includes(eventType)) {
            setTimeout(() => closeConnection(), 100); // Delayed close to ensure event is sent
          }
        } catch (error) {
          console.error('Error sending SSE event:', error);
          closeConnection();
        }
      }
    };

    // Start execution first to get sessionId
    sessionId = await browserUseService.startSseExecution(user_request, maxSteps, session_id);
    
    // Set SSE sender for this specific session
    browserUseService.setSseSender(sessionId, sendEvent);

    // Handle client disconnect
    req.on('close', () => {
      console.log('Browser-use SSE: Client disconnected');
      connectionClosed = true;
      if (sessionId) {
        browserUseService.clearSseSender(sessionId);
        browserUseService.cancelSession(sessionId).catch(error => {
          console.error('Error cancelling session on close:', error);
        });
      }
    });

    req.on('error', (error) => {
      console.error('Browser-use SSE: Connection error:', error);
      closeConnection();
      if (sessionId) {
        browserUseService.clearSseSender(sessionId);
        browserUseService.cancelSession(sessionId).catch(cancelError => {
          console.error('Error cancelling session on error:', cancelError);
        });
      }
    });

  } catch (error) {
    console.error('Error in SSE endpoint:', error);

    // Clean up resources
    if (sessionId) {
      browserUseService.clearSseSender(sessionId);
      browserUseService.cancelSession(sessionId).catch(cancelError => {
        console.error('Error cancelling session in catch block:', cancelError);
      });
    }

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to start SSE browser-use execution',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    } else {
      // If SSE headers already sent, send error event and close connection
      try {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({
          message: 'Server error occurred',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        })}\n\n`);
      } catch (writeError) {
        console.error('Error writing error event:', writeError);
      }
      closeConnection();
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
router.post('/cancel', async (req, res) => {
  try {
    const { sessionId } = req.body;

    // If no sessionId provided, cancel all sessions
    if (!sessionId) {
      const result = await browserUseService.cancelAllSessions();
      
      return res.json({
        success: true,
        message: `Cancelled ${result.cancelled} out of ${result.total} active sessions`,
        cancelled: result.cancelled,
        total: result.total,
        timestamp: new Date().toISOString(),
      });
    }

    // Cancel specific session
    const cancelled = await browserUseService.cancelSession(sessionId);

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
