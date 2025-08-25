import { BrowserUseSSEAgent, type BrowserUseEvent } from './browser_use_sse_agent';
import { execute } from './browser_use_agent';
import { randomUUID } from 'crypto';

export class BrowserUseService {
  private sseSender?: (eventType: string, data: any) => void;
  private activeSessions = new Map<string, BrowserUseSSEAgent>();
  private heartbeatInterval?: NodeJS.Timeout;
  private heartbeatIntervalMs: number = 30000; // 30秒心跳间隔
  private isHeartbeatActive: boolean = false;

  /**
   * Set SSE sender function for real-time event streaming
   */
  setSseSender(sender: (eventType: string, data: any) => void): void {
    this.sseSender = sender;
    this.startHeartbeat();
  }

  /**
   * Clear SSE sender function
   */
  clearSseSender(): void {
    this.sseSender = undefined;
    this.stopHeartbeat();
  }

  /**
   * Start heartbeat mechanism
   */
  private startHeartbeat(): void {
    if (this.isHeartbeatActive) {
      return;
    }

    this.isHeartbeatActive = true;
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);

    console.log(`Heartbeat started with interval: ${this.heartbeatIntervalMs}ms`);
  }

  /**
   * Stop heartbeat mechanism
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    this.isHeartbeatActive = false;
    console.log('Heartbeat stopped');
  }

  /**
   * Send heartbeat event
   */
  private sendHeartbeat(): void {
    if (this.sseSender) {
      this.sendEvent('heartbeat', {
        message: 'Server heartbeat',
        timestamp: new Date().toISOString(),
        serverTime: Date.now()
      });
    }
  }

  /**
   * Set heartbeat interval (in milliseconds)
   */
  setHeartbeatInterval(intervalMs: number): void {
    if (intervalMs < 5000) {
      throw new Error('Heartbeat interval must be at least 5 seconds');
    }
    
    this.heartbeatIntervalMs = intervalMs;
    
    // Restart heartbeat with new interval if currently active
    if (this.isHeartbeatActive) {
      this.stopHeartbeat();
      this.startHeartbeat();
    }
  }

  /**
   * Send event through SSE if sender is available
   */
  private sendEvent(eventType: string, data: any): void {
    if (this.sseSender) {
      this.sseSender(eventType, data);
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
    this.sendEvent('connection', {
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
          this.sendEvent('execution_error', {
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
      this.sendEvent('start_error', {
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
        this.sendEvent(event.type, {
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
      this.sendEvent('execution_error', {
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
        heartbeat: {
          active: this.isHeartbeatActive,
          intervalMs: this.heartbeatIntervalMs,
          hasSSEConnection: !!this.sseSender
        },
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

      this.sendEvent('session_cancelled', {
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
   * Get heartbeat status
   */
  getHeartbeatStatus(): { active: boolean; intervalMs: number; hasSSEConnection: boolean } {
    return {
      active: this.isHeartbeatActive,
      intervalMs: this.heartbeatIntervalMs,
      hasSSEConnection: !!this.sseSender
    };
  }

  /**
   * Cleanup service resources
   */
  cleanup(): void {
    console.log('Cleaning up BrowserUseService...');
    
    // Stop heartbeat
    this.stopHeartbeat();
    
    // Clear SSE sender
    this.clearSseSender();
    
    // Cancel all active sessions
    for (const sessionId of this.activeSessions.keys()) {
      this.cancelSession(sessionId);
    }
    
    // Clear active sessions map
    this.activeSessions.clear();
    
    console.log('BrowserUseService cleanup completed');
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
