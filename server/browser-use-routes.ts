import express from 'express';
import { main as extractTicketsAPI } from './openapi';

const router = express.Router();

// Browser-use run endpoint
router.post('/run', async (req, res) => {
  try {
    const { userRequest, sessionId } = req.body;

    console.log('Starting browser-use run...');
    console.log('User Request:', userRequest || 'Using default request');
    console.log('Session ID:', sessionId || 'default');

    const result = await extractTicketsAPI(userRequest, sessionId);

    res.json({
      success: true,
      message: 'Browser-use run completed successfully',
      data: result,
      parameters: {
        userRequest: userRequest || 'Default browser-use run request',
        sessionId: sessionId || 'default'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error running browser-use:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to run browser-use',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
