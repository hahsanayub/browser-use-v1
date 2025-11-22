/**
 * Observability Decorators and Utilities
 *
 * Provides debugging and performance tracking capabilities
 * for browser automation operations.
 *
 * Note: TypeScript decorators work differently than Python.
 * These are implemented as wrapper functions that can be used
 * in a similar way to decorators.
 */

import { createLogger } from './logging-config.js';
import { time_execution_async } from './utils.js';

const logger = createLogger('browser_use.observability');

/**
 * Debug observation configuration
 */
export interface ObserveDebugOptions {
	/** Enable detailed logging */
	verbose?: boolean;
	/** Log function arguments */
	logArgs?: boolean;
	/** Log return values */
	logResult?: boolean;
	/** Log execution time */
	logTime?: boolean;
	/** Custom logger instance */
	logger?: ReturnType<typeof createLogger>;
}

/**
 * Observe and debug async function execution
 * Wraps an async function to add logging and debugging capabilities
 *
 * @example
 * const debuggedFn = observeDebug(myAsyncFn, { verbose: true, logArgs: true });
 * await debuggedFn(arg1, arg2);
 */
export function observeDebug<T extends (...args: any[]) => Promise<any>>(
	fn: T,
	options: ObserveDebugOptions = {}
): T {
	const {
		verbose = false,
		logArgs = true,
		logResult = false,
		logTime = true,
		logger: customLogger = logger,
	} = options;

	const wrappedFn = async function (this: any, ...args: any[]) {
		const fnName = fn.name || 'anonymous';
		const startTime = Date.now();

		try {
			// Log function entry
			if (verbose) {
				customLogger.debug(`→ Entering ${fnName}`);
			}

			// Log arguments
			if (logArgs && args.length > 0) {
				customLogger.debug(`${fnName} arguments:`, args);
			}

			// Execute function
			const result = await fn.apply(this, args);

			// Log execution time
			if (logTime) {
				const duration = Date.now() - startTime;
				customLogger.debug(`${fnName} completed in ${duration}ms`);
			}

			// Log result
			if (logResult) {
				customLogger.debug(`${fnName} result:`, result);
			}

			// Log function exit
			if (verbose) {
				customLogger.debug(`← Exiting ${fnName}`);
			}

			return result;
		} catch (error) {
			const duration = Date.now() - startTime;
			customLogger.error(
				`${fnName} failed after ${duration}ms: ${(error as Error).message}`
			);
			customLogger.debug(`${fnName} error stack:`, (error as Error).stack);
			throw error;
		}
	} as T;

	// Preserve function name
	Object.defineProperty(wrappedFn, 'name', {
		value: fn.name,
		configurable: true,
	});

	return wrappedFn;
}

/**
 * Method decorator for observing debug (TypeScript experimental decorators)
 * This requires "experimentalDecorators": true in tsconfig.json
 *
 * @example
 * class MyClass {
 *   @observeDebugMethod({ verbose: true })
 *   async myMethod(arg: string) {
 *     // method implementation
 *   }
 * }
 */
export function observeDebugMethod(options: ObserveDebugOptions = {}) {
	return function (
		target: any,
		propertyKey: string,
		descriptor: PropertyDescriptor
	) {
		const originalMethod = descriptor.value;

		descriptor.value = observeDebug(originalMethod, {
			...options,
			logger: options.logger || createLogger(`${target.constructor.name}.${propertyKey}`),
		});

		return descriptor;
	};
}

/**
 * Performance tracking for async functions
 * Combines time execution tracking with debug observation
 *
 * @example
 * const trackedFn = trackPerformance(myAsyncFn, 'MyOperation');
 * await trackedFn(arg1, arg2);
 */
export function trackPerformance<T extends (...args: any[]) => Promise<any>>(
	fn: T,
	operationName?: string
): T {
	const name = operationName || fn.name || 'anonymous';

	return time_execution_async(name)(fn) as T;
}

/**
 * Comprehensive observability wrapper
 * Combines debugging, performance tracking, and error handling
 *
 * @example
 * const observedFn = withObservability(myAsyncFn, {
 *   name: 'CriticalOperation',
 *   debug: true,
 *   trackPerformance: true,
 *   onError: (error) => console.error('Operation failed:', error)
 * });
 */
export function withObservability<T extends (...args: any[]) => Promise<any>>(
	fn: T,
	options: {
		name?: string;
		debug?: boolean;
		debugOptions?: ObserveDebugOptions;
		trackPerformance?: boolean;
		onError?: (error: Error) => void;
		onSuccess?: (result: any) => void;
	} = {}
): T {
	const {
		name = fn.name,
		debug = false,
		debugOptions = {},
		trackPerformance: shouldTrackPerformance = true,
		onError,
		onSuccess,
	} = options;

	let wrappedFn = fn;

	// Apply debug observation if requested
	if (debug) {
		wrappedFn = observeDebug(wrappedFn, debugOptions);
	}

	// Apply performance tracking if requested
	if (shouldTrackPerformance) {
		wrappedFn = trackPerformance(wrappedFn, name);
	}

	// Add error/success callbacks
	if (onError || onSuccess) {
		const callbackFn = async function (this: any, ...args: any[]) {
			try {
				const result = await wrappedFn.apply(this, args);
				if (onSuccess) {
					onSuccess(result);
				}
				return result;
			} catch (error) {
				if (onError) {
					onError(error as Error);
				}
				throw error;
			}
		} as T;

		wrappedFn = callbackFn;
	}

	return wrappedFn;
}

/**
 * Create a debug trace for a series of operations
 * Useful for tracking complex workflows
 */
export class OperationTrace {
	private operations: Array<{
		name: string;
		startTime: number;
		endTime?: number;
		duration?: number;
		status: 'pending' | 'success' | 'error';
		error?: Error;
	}> = [];

	private logger: ReturnType<typeof createLogger>;
	private traceName: string;

	constructor(traceName: string, customLogger?: ReturnType<typeof createLogger>) {
		this.traceName = traceName;
		this.logger = customLogger || createLogger(`trace.${traceName}`);
	}

	/**
	 * Start tracking an operation
	 */
	startOperation(name: string): void {
		this.operations.push({
			name,
			startTime: Date.now(),
			status: 'pending',
		});
		this.logger.debug(`Started operation: ${name}`);
	}

	/**
	 * Mark an operation as completed successfully
	 */
	completeOperation(name: string): void {
		const op = this.operations.find(o => o.name === name && o.status === 'pending');
		if (op) {
			op.endTime = Date.now();
			op.duration = op.endTime - op.startTime;
			op.status = 'success';
			this.logger.debug(`Completed operation: ${name} (${op.duration}ms)`);
		}
	}

	/**
	 * Mark an operation as failed
	 */
	failOperation(name: string, error: Error): void {
		const op = this.operations.find(o => o.name === name && o.status === 'pending');
		if (op) {
			op.endTime = Date.now();
			op.duration = op.endTime - op.startTime;
			op.status = 'error';
			op.error = error;
			this.logger.error(`Failed operation: ${name} (${op.duration}ms) - ${error.message}`);
		}
	}

	/**
	 * Get trace summary
	 */
	getSummary(): {
		traceName: string;
		totalOperations: number;
		successCount: number;
		errorCount: number;
		pendingCount: number;
		totalDuration: number;
		operations: typeof this.operations;
	} {
		const successCount = this.operations.filter(o => o.status === 'success').length;
		const errorCount = this.operations.filter(o => o.status === 'error').length;
		const pendingCount = this.operations.filter(o => o.status === 'pending').length;
		const totalDuration = this.operations.reduce((sum, op) => sum + (op.duration || 0), 0);

		return {
			traceName: this.traceName,
			totalOperations: this.operations.length,
			successCount,
			errorCount,
			pendingCount,
			totalDuration,
			operations: this.operations,
		};
	}

	/**
	 * Log trace summary
	 */
	logSummary(): void {
		const summary = this.getSummary();
		this.logger.info(
			`Trace "${this.traceName}" completed: ${summary.successCount} succeeded, ${summary.errorCount} failed, ${summary.pendingCount} pending (total: ${summary.totalDuration}ms)`
		);
	}
}

/**
 * Simple performance counter for tracking operation metrics
 */
export class PerformanceCounter {
	private counters = new Map<string, { count: number; totalTime: number; minTime: number; maxTime: number }>();
	private logger: ReturnType<typeof createLogger>;

	constructor(customLogger?: ReturnType<typeof createLogger>) {
		this.logger = customLogger || createLogger('performance_counter');
	}

	/**
	 * Record an operation execution
	 */
	record(operationName: string, durationMs: number): void {
		const current = this.counters.get(operationName) || {
			count: 0,
			totalTime: 0,
			minTime: Infinity,
			maxTime: 0,
		};

		this.counters.set(operationName, {
			count: current.count + 1,
			totalTime: current.totalTime + durationMs,
			minTime: Math.min(current.minTime, durationMs),
			maxTime: Math.max(current.maxTime, durationMs),
		});
	}

	/**
	 * Get statistics for an operation
	 */
	getStats(operationName: string): {
		count: number;
		avgTime: number;
		minTime: number;
		maxTime: number;
		totalTime: number;
	} | null {
		const counter = this.counters.get(operationName);
		if (!counter) {
			return null;
		}

		return {
			count: counter.count,
			avgTime: counter.totalTime / counter.count,
			minTime: counter.minTime,
			maxTime: counter.maxTime,
			totalTime: counter.totalTime,
		};
	}

	/**
	 * Get all statistics
	 */
	getAllStats(): Map<string, ReturnType<PerformanceCounter['getStats']>> {
		const stats = new Map();
		for (const [name] of this.counters) {
			stats.set(name, this.getStats(name));
		}
		return stats;
	}

	/**
	 * Log statistics summary
	 */
	logSummary(): void {
		this.logger.info('Performance Counter Summary:');
		for (const [name, stats] of this.getAllStats()) {
			if (stats) {
				this.logger.info(
					`  ${name}: count=${stats.count}, avg=${stats.avgTime.toFixed(2)}ms, min=${stats.minTime.toFixed(2)}ms, max=${stats.maxTime.toFixed(2)}ms`
				);
			}
		}
	}

	/**
	 * Reset all counters
	 */
	reset(): void {
		this.counters.clear();
		this.logger.debug('Performance counters reset');
	}
}
