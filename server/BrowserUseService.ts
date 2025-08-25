import { BrowserUseSSEAgent, type BrowserUseEvent } from './browser_use_sse_agent';
import { execute } from './browser_use_agent';
import { randomUUID } from 'crypto';

export class BrowserUseService {
  private sseSender?: (eventLevel: string, eventType: string, data: any) => void;
  private activeSessions = new Map<string, BrowserUseSSEAgent>();

  /**
   * Set SSE sender function for real-time event streaming
   */
  setSseSender(sender: (eventLevel: string, eventType: string, data: any) => void): void {
    this.sseSender = sender;
  }

  /**
   * Clear SSE sender function
   */
  clearSseSender(): void {
    this.sseSender = undefined;
  }

  /**
   * Send event through SSE if sender is available
   */
  private sendEvent(eventLevel: string, eventType: string, data: any): void {
    if (this.sseSender) {
      this.sseSender(eventLevel, eventType, data);
    }
  }

  /**
   * Execute browser-use task with regular response
   */
  async executeBrowserUse(userRequest?: string, sessionId?: string): Promise<any> {
    try {
      console.log('Starting browser-use execution...');
      console.log('User Request:', userRequest || 'Using default request');
      console.log('Session ID:', sessionId || 'default');

      const result = await execute(userRequest || 'Default browser-use request', sessionId || 'default');

      return {
        success: true,
        message: 'Browser-use execution completed successfully',
        data: result,
        parameters: {
          userRequest: userRequest || 'Default browser-use request',
          sessionId: sessionId || 'default'
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error executing browser-use:', error);
      throw error;
    }
  }

  /**
   * Start SSE execution for browser-use task
   */
  async startSseExecution(userRequest: string, maxSteps: number = 200, sessionId?: string): Promise<string> {
    const finalSessionId = sessionId || randomUUID();

    console.log('Starting SSE browser-use execution...');
    console.log('User Request:', userRequest);
    console.log('Session ID:', finalSessionId);
    console.log('Max Steps:', maxSteps);

    // Send initial connection event
    this.sendEvent('info', 'connection', {
      message: 'SSE connection established',
      sessionId: finalSessionId,
      timestamp: new Date().toISOString()
    });

    try {
      // Create and store agent instance
      const agent = new BrowserUseSSEAgent(finalSessionId);
      this.activeSessions.set(finalSessionId, agent);

      // Start execution in background
      this.executeWithSseEvents(agent, userRequest, maxSteps, finalSessionId)
        .catch(error => {
          console.error('Error in SSE execution:', error);
          this.sendEvent('error', 'execution_error', {
            message: `Execution error: ${error}`,
            sessionId: finalSessionId,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
          });
        })
        .finally(() => {
          // Clean up session
          this.activeSessions.delete(finalSessionId);
        });

      return finalSessionId;
    } catch (error) {
      console.error('Error starting SSE execution:', error);
      this.sendEvent('error', 'start_error', {
        message: `Failed to start execution: ${error}`,
        sessionId: finalSessionId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Execute browser-use with SSE events
   */
  private async executeWithSseEvents(
    agent: BrowserUseSSEAgent,
    userRequest: string,
    maxSteps: number,
    sessionId: string
  ): Promise<void> {
    try {
      // Use the unified sendEvent function with correct signature
      const sendEvent = (event: any) => {
        this.sendEvent('data', event.type, {
          ...event,
          sessionId,
          timestamp: new Date().toISOString()
        });
      };

      for await (const event of agent.executeWithSSE(userRequest, maxSteps, sessionId, sendEvent)) {
        // Event is already sent through sendEvent callback

        // Break on completion or error events
        if (['agent_complete', 'error', 'cancelled'].includes(event.type)) {
          break;
        }
      }
    } catch (error) {
      console.error('Error in executeWithSseEvents:', error);
      this.sendEvent('error', 'execution_error', {
        message: `Execution error: ${error}`,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get service status
   */
  getStatus(): any {
    const activeSessions = BrowserUseSSEAgent.getActiveSessions();

    return {
      success: true,
      message: 'Browser-use service is running',
      status: {
        serviceRunning: true,
        activeSessionCount: activeSessions.length,
        timestamp: Date.now()
      },
      activeSessions: activeSessions,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Cancel a session
   */
  cancelSession(sessionId: string): boolean {
    const cancelled = BrowserUseSSEAgent.cancelSession(sessionId);

    if (cancelled) {
      // Remove from local tracking
      this.activeSessions.delete(sessionId);

      this.sendEvent('info', 'session_cancelled', {
        message: `Session ${sessionId} cancelled successfully`,
        sessionId,
        timestamp: new Date().toISOString()
      });
    }

    return cancelled;
  }

  /**
   * Get active sessions
   */
  getActiveSessions(): Array<{ sessionId: string; status: any }> {
    return BrowserUseSSEAgent.getActiveSessions();
  }

  /**
   * Test execution (non-SSE)
   */
  async testExecution(userRequest: string, maxSteps: number = 200, sessionId?: string): Promise<any> {
    try {
      console.log('Starting test browser-use execution...');
      console.log('User Request:', userRequest);
      console.log('Session ID:', sessionId || 'test');
      console.log('Max Steps:', maxSteps);

      const result = await execute(userRequest, sessionId || 'test');

      return {
        success: true,
        message: 'Browser-use test execution completed successfully',
        data: result,
        parameters: {
          userRequest: userRequest,
          sessionId: sessionId || 'test',
          maxSteps: maxSteps
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error in test execution:', error);
      throw error;
    }
  }
}
