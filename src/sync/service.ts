import axios from 'axios';
import { createLogger } from '../logging-config.js';
import { CONFIG } from '../config.js';
import type { BaseEvent } from '../agent/cloud-events.js';
import { DeviceAuthClient, TEMP_USER_ID } from './auth.js';

const logger = createLogger('browser_use.sync');

const stripTrailingSlash = (input: string) => input.replace(/\/+$/, '');

export interface CloudSyncOptions {
	baseUrl?: string;
	enableAuth?: boolean;
}

const ensureArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

export class CloudSync {
	private readonly baseUrl: string;
	private readonly enableAuth: boolean;
	public readonly auth_client?: DeviceAuthClient;
	private pendingEvents: BaseEvent[] = [];
	private authTask: Promise<void> | null = null;
	private sessionId: string | null = null;

	constructor(options: CloudSyncOptions = {}) {
		this.baseUrl = stripTrailingSlash(options.baseUrl ?? CONFIG.BROWSER_USE_CLOUD_API_URL);
		this.enableAuth = options.enableAuth ?? true;
		this.auth_client = this.enableAuth ? new DeviceAuthClient(this.baseUrl) : undefined;
	}

	async handle_event(event: BaseEvent) {
		try {
			if (event.event_type === 'CreateAgentSessionEvent' && (event as any)?.id) {
				this.sessionId = String((event as any).id);
			}

			if (event.event_type === 'CreateAgentStepEvent') {
				const raw = event as unknown as Record<string, any>;
				const step = raw?.step ?? raw?.payload?.step;
				if (step === 2 && this.enableAuth && this.auth_client && !this.authTask) {
					if (this.sessionId) {
						this.authTask = this.backgroundAuth(this.sessionId);
					} else {
						logger.warning('Cannot start cloud auth, session_id missing');
					}
				}
			}

			await this.sendEvent(event);
		} catch (error) {
			logger.error(`Failed to handle ${event.event_type}: ${(error as Error).message}`);
		}
	}

	private async sendEvent(event: BaseEvent) {
		try {
			const headers: Record<string, string> = {};
			const authClient = this.auth_client;
			const userId = authClient ? authClient.user_id : TEMP_USER_ID;
			event.user_id = userId;
			if (authClient) {
				Object.assign(headers, authClient.get_headers());
				event.device_id = authClient.device_id;
			}

			const payload = typeof (event as any)?.toJSON === 'function' ? (event as any).toJSON() : { ...event };
			const events = ensureArray(payload);
			await axios.post(
				`${this.baseUrl}/api/v1/events`,
				{ events: events.map((entry) => ({ ...entry, device_id: entry.device_id ?? authClient?.device_id })) },
				{ headers, timeout: 10_000 },
			);
		} catch (error: any) {
			const status = error?.response?.status;
			if (status === 401 && this.auth_client && !this.auth_client.is_authenticated) {
				this.pendingEvents.push(event);
				return;
			}
			if (status) {
				logger.debug(`Cloud sync HTTP ${status}: ${error?.response?.data ?? error}`);
			} else if (error?.code === 'ECONNABORTED') {
				logger.warning(`Cloud sync timeout sending ${event.event_type}`);
			} else {
				logger.warning(`Cloud sync error: ${error?.message ?? error}`);
			}
		}
	}

	private async backgroundAuth(agentSessionId: string) {
		const authClient = this.auth_client;
		if (!authClient) {
			return;
		}
		try {
			if (authClient.is_authenticated) {
				const frontend = CONFIG.BROWSER_USE_CLOUD_UI_URL || this.baseUrl.replace('//api.', '//cloud.');
				const sessionUrl = `${stripTrailingSlash(frontend)}/agent/${agentSessionId}`;
				const divider = '─'.repeat(Math.max((process.stdout?.columns ?? 80) - 40, 20));
				logger.info(divider);
				logger.info('🌐  View the details of this run in Browser Use Cloud:');
				logger.info(`    👉  ${sessionUrl}`);
				logger.info(divider + '\n');
				return;
			}

			const success = await authClient.authenticate(agentSessionId, true);
			if (success) {
				await this.resendPendingEvents();
			}
		} catch (error) {
			logger.debug(`Cloud sync auth error: ${(error as Error).message}`);
		}
	}

	private async resendPendingEvents() {
		if (!this.pendingEvents.length) {
			return;
		}
		const events = [...this.pendingEvents];
		this.pendingEvents = [];
		for (const event of events) {
			try {
				await this.sendEvent(event);
			} catch (error) {
				logger.warning(`Failed to resend event ${event.event_type}: ${(error as Error).message}`);
			}
		}
	}

	async wait_for_auth() {
		if (this.authTask) {
			try {
				await this.authTask;
			} catch {
				/* ignore */
			}
		}
	}

	async authenticate(showInstructions = true) {
		if (!this.auth_client) {
			return false;
		}
		return this.auth_client.authenticate(this.sessionId, showInstructions);
	}
}
