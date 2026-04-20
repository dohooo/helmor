/**
 * Queue-backed `AsyncIterable<T>` for Claude Agent SDK streaming-input mode.
 *
 * The SDK's `query({ prompt })` accepts an `AsyncIterable<SDKUserMessage>`
 * that stays open across the life of a session. `streamInput()` and
 * mid-turn `steer()` both rely on the iterable reading new messages
 * after the initial prompt — so we hand the SDK a pushable queue and
 * `push()` into it whenever we want to inject another user message.
 */

export interface Pushable<T> extends AsyncIterable<T> {
	push(value: T): void;
	close(): void;
	/** True once `close()` has been called. Further pushes are ignored. */
	readonly closed: boolean;
}

export function createPushable<T>(): Pushable<T> {
	const queue: T[] = [];
	let closed = false;
	let waiter: ((result: IteratorResult<T>) => void) | null = null;

	const iterator: AsyncIterator<T> = {
		next(): Promise<IteratorResult<T>> {
			if (queue.length > 0) {
				return Promise.resolve({ value: queue.shift() as T, done: false });
			}
			if (closed) {
				return Promise.resolve({
					value: undefined as unknown as T,
					done: true,
				});
			}
			return new Promise((resolve) => {
				waiter = resolve;
			});
		},
		return(): Promise<IteratorResult<T>> {
			closed = true;
			if (waiter) {
				const w = waiter;
				waiter = null;
				w({ value: undefined as unknown as T, done: true });
			}
			return Promise.resolve({ value: undefined as unknown as T, done: true });
		},
	};

	return {
		push(value: T) {
			if (closed) return;
			if (waiter) {
				const w = waiter;
				waiter = null;
				w({ value, done: false });
				return;
			}
			queue.push(value);
		},
		close() {
			if (closed) return;
			closed = true;
			if (waiter) {
				const w = waiter;
				waiter = null;
				w({ value: undefined as unknown as T, done: true });
			}
		},
		get closed() {
			return closed;
		},
		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
}
