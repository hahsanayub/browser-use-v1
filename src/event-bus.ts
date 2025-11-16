import EventEmitter from 'eventemitter3';

export type EventHandler<T = any> = (event: T) => void | Promise<void>;

export class EventBus {
	private emitter = new EventEmitter();

	constructor(public readonly name: string) {}

	on<T = any>(eventType: string, handler: EventHandler<T>) {
		this.emitter.on(eventType, handler);
	}

	dispatch<T extends { event_type?: string }>(event: T) {
		const eventType = event?.event_type ?? (event as any)?.constructor?.name ?? 'event';
		this.emitter.emit(eventType, event);
		this.emitter.emit('*', event);
	}

	async stop() {
		this.emitter.removeAllListeners();
	}
}
