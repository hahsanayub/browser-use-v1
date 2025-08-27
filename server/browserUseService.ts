import { BrowserUseSSEAgent } from './browserUseAgent';
import { randomUUID } from 'crypto';


export interface BrowserUseEvent {
  type: string;
  session_id: string;
  timestamp?: string;
  step?: number;
  data?: any;
  message?: string;
  error?: string;
  url?: string;
  history?: any[];
  screenshot?: string;
}

export class BrowserUseService {
  // Unified session storage containing agent instances, metadata and dedicated SSE sender
  private sessions = new Map<string, {
    agent: BrowserUseSSEAgent;
    createdAt: Date;
    status: 'active' | 'completed' | 'cancelled' | 'error';
    sseSender?: (eventType: string, data: any) => void;
  }>();
  private heartbeatInterval?: NodeJS.Timeout;
  private heartbeatIntervalMs: number = 20000;
  private isHeartbeatActive: boolean = false;

  /**
   * Set SSE sender function for a specific session
   */
  setSseSender(sessionId: string, sender: (eventType: string, data: any) => void): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.sseSender = sender;
      this.startHeartbeat();
    }
  }

  /**
   * Clear SSE sender function for a specific session
   */
  clearSseSender(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.sseSender = undefined;
    }

    // Stop heartbeat if no active SSE connections exist
    const hasActiveSenders = Array.from(this.sessions.values()).some(s => s.sseSender);
    if (!hasActiveSenders) {
      this.stopHeartbeat();
    }
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
   * Send heartbeat event to all active sessions
   * Check if agents are cancelled and remove cancelled sessions
   */
  private sendHeartbeat(): void {
    const heartbeatData = {
      message: `ping - ${new Date().toISOString()}`
    };

    // Create array to track sessions to remove
    const sessionsToRemove: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      // Check if agent is cancelled
      const agentStatus = session.agent.getStatus();
      if (agentStatus && agentStatus.cancelled) {
        // Mark session for removal
        sessionsToRemove.push(sessionId);
        console.log(`Session ${sessionId} agent is cancelled, marking for removal`);
        continue;
      }

      // Send heartbeat to active sessions with SSE sender
      if (session.sseSender) {
        this.sendEventToSession(sessionId, '', heartbeatData);
      }
    }

    // Remove cancelled sessions
    for (const sessionId of sessionsToRemove) {
      this.removeSession(sessionId);
      console.log(`Removed cancelled session: ${sessionId}`);
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
   * Send event to a specific session through SSE if sender is available
   */
  private sendEventToSession(sessionId: string, eventType: string, data: any): void {
    const session = this.sessions.get(sessionId);
    if (session?.sseSender) {
      session.sseSender(eventType, data);
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

    try {
      // Create agent instance
      const agent = new BrowserUseSSEAgent(finalSessionId);

      // Register session with metadata
      this.sessions.set(finalSessionId, {
        agent,
        createdAt: new Date(),
        status: 'active'
      });

      // Send initial connection event (now that session exists)
      this.sendEventToSession(finalSessionId, 'connection', {
        message: 'SSE connection established',
        sessionId: finalSessionId,
        timestamp: new Date().toISOString()
      });

      // Start execution in background
      this.executeWithSseEvents(agent, userRequest, maxSteps, finalSessionId)
        .catch(error => {
          console.error('Error in SSE execution:', error);
          this.sendEventToSession(finalSessionId, 'execution_error', {
            message: `Execution error: ${error}`,
            sessionId: finalSessionId,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
          });
        })
        .finally(() => {
          // Mark session as completed if still exists
          const session = this.sessions.get(finalSessionId);
          if (session && session.status === 'active') {
            session.status = 'completed';
          }
        });

      return finalSessionId;
    } catch (error) {
      console.error('Error starting SSE execution:', error);
      this.sendEventToSession(finalSessionId, 'start_error', {
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
    let executionCompleted = false;

    try {
      // Use the unified sendEvent function with correct signature
      const sendEvent = (event: any) => {
        this.sendEventToSession(sessionId, event.type, {
          ...event,
          sessionId,
          timestamp: new Date().toISOString()
        });
      };

      for await (const event of agent.executeWithSSE(userRequest, maxSteps, sessionId, sendEvent)) {
        // Event is already sent through sendEvent callback

        // Break on completion or error events
        if (['agent_complete', 'error', 'cancelled'].includes(event.type)) {
          executionCompleted = true;
          break;
        }
      }

      // If completed normally but no agent_complete event received, send session_complete event
      if (!executionCompleted) {
        this.sendEventToSession(sessionId, 'session_complete', {
          message: 'Session completed successfully',
          sessionId,
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      console.error('Error in executeWithSseEvents:', error);

      // Update session status to error
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'error';
      }

      // Send execution error event
      this.sendEventToSession(sessionId, 'execution_error', {
        message: `Execution error: ${error}`,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });

    } finally {
      // Update session status (if still active)
      const session = this.sessions.get(sessionId);
      if (session && session.status === 'active') {
        if (!executionCompleted) {
          session.status = 'completed';
        }
      }

      // Note: Don't call clearSseSender() here, let the route layer control connection closure
      // This ensures the final events can be sent correctly
      console.log(`Session ${sessionId} execution finished, final status: ${session?.status}`);
    }
  }

  /**
   * Get service status
   */
  getStatus(): any {
    const activeSessions = this.getActiveSessions();

    return {
      success: true,
      message: 'Browser-use service is running',
      status: {
        serviceRunning: true,
        activeSessionCount: activeSessions.length,
        heartbeat: {
          active: this.isHeartbeatActive,
          intervalMs: this.heartbeatIntervalMs,
          hasSSEConnection: Array.from(this.sessions.values()).some(s => s.sseSender)
        },
        timestamp: Date.now()
      },
      activeSessions: activeSessions,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Cancel a specific session/**
   * Cancel execution of a single session
   */
  async cancelSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);

    if (session && session.status === 'active') {
      // Cancel agent execution
      await session.agent.cancel();

      // Update status to cancelled
      session.status = 'cancelled';

      this.sendEventToSession(sessionId, 'session_cancelled', {
        message: `Session ${sessionId} cancelled successfully`,
        sessionId,
        timestamp: new Date().toISOString()
      });

      return true;
    }

    return false;
  }

  /**
   * Cancel all active sessions
   */
  async cancelAllSessions(): Promise<{ cancelled: number; total: number }> {
    const allSessions = Array.from(this.sessions.entries());
    const activeSessions = allSessions.filter(([_, session]) => session.status === 'active');
    
    let cancelledCount = 0;
    
    for (const [sessionId, _] of activeSessions) {
      try {
        const cancelled = await this.cancelSession(sessionId);
        if (cancelled) {
          cancelledCount++;
        }
      } catch (error) {
        console.error(`Failed to cancel session ${sessionId}:`, error);
      }
    }
    
    return {
      cancelled: cancelledCount,
      total: activeSessions.length
    };
  }

  /**
   * Get heartbeat status
   */
  getHeartbeatStatus(): { active: boolean; intervalMs: number; hasSSEConnection: boolean } {
    return {
      active: this.isHeartbeatActive,
      intervalMs: this.heartbeatIntervalMs,
      hasSSEConnection: Array.from(this.sessions.values()).some(s => s.sseSender)
    };
  }

  /**
   * Get a specific session by ID
   */
  getSession(sessionId: string): BrowserUseSSEAgent | undefined {
    const session = this.sessions.get(sessionId);
    return session?.agent;
  }

  /**
   * Remove a session from registry (physical deletion)
   */
  removeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Get all sessions with their status
   */
  getAllSessions(): Array<{ sessionId: string; status: string; createdAt: Date }> {
    return Array.from(this.sessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      status: session.status,
      createdAt: session.createdAt
    }));
  }

  /**
   * Get active sessions with detailed status
   */
  getActiveSessions(): Array<{ sessionId: string; status: any }> {
    const sessionList: Array<{ sessionId: string; status: any }> = [];
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      sessionList.push({
        sessionId,
        status: {
          sessionId,
          isActive: session.status === 'active',
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          agentStatus: session.agent.getStatus ? session.agent.getStatus() : null
        }
      });
    }
    return sessionList;
  }

}
