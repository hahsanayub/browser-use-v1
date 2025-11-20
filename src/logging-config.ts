import { Writable } from 'node:stream';

export type LogLevel = 'debug' | 'info' | 'result' | 'warning' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	result: 25,
	warning: 30,
	error: 40,
};

type SupportedStream = Writable | Console;

interface SetupLoggingOptions {
	stream?: Writable;
	logLevel?: LogLevel;
	forceSetup?: boolean;
}

let configured = false;
let globalLevel: LogLevel = (process.env.BROWSER_USE_LOGGING_LEVEL as LogLevel) || 'info';
let outputStream: SupportedStream = process.stderr;

const formatMessage = (level: LogLevel, name: string, message: string) => {
	if (level === 'result') {
		return message;
	}

	const paddedLevel = level.toUpperCase().padEnd(7, ' ');
	return `${paddedLevel} [${name}] ${message}`;
};

export class Logger {
	constructor(private readonly name: string) { }

	private shouldLog(level: LogLevel) {
		return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[globalLevel];
	}

	public get level(): LogLevel {
		return globalLevel;
	}

	private emit(level: LogLevel, message: string, ...args: unknown[]) {
		if (!this.shouldLog(level)) {
			return;
		}

		const formatted = formatMessage(level, this.name, message);
		const payload = args.length ? `${formatted} ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}` : formatted;

		if ('write' in outputStream) {
			outputStream.write(`${payload}\n`);
		} else {
			switch (level) {
				case 'error':
					console.error(payload);
					break;
				case 'warning':
					console.warn(payload);
					break;
				default:
					console.log(payload);
			}
		}
	}

	debug(message: string, ...args: unknown[]) {
		this.emit('debug', message, ...args);
	}

	info(message: string, ...args: unknown[]) {
		this.emit('info', message, ...args);
	}

	result(message: string, ...args: unknown[]) {
		this.emit('result', message, ...args);
	}

	warning(message: string, ...args: unknown[]) {
		this.emit('warning', message, ...args);
	}

	// Alias for compatibility
	warn(message: string, ...args: unknown[]) {
		this.warning(message, ...args);
	}

	error(message: string, ...args: unknown[]) {
		this.emit('error', message, ...args);
	}

	child(suffix: string) {
		return new Logger(`${this.name}.${suffix}`);
	}
}

export const createLogger = (name: string) => new Logger(name);

export const setupLogging = (options: SetupLoggingOptions = {}) => {
	if (configured && !options.forceSetup) {
		return createLogger('browser_use');
	}

	globalLevel = options.logLevel || (process.env.BROWSER_USE_LOGGING_LEVEL as LogLevel) || 'info';
	outputStream = options.stream || process.stderr;
	configured = true;

	return createLogger('browser_use');
};

export const logger = createLogger('browser_use');
