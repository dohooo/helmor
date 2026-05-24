// MRU stack of workspace ids — most-recently-used first. In-memory only;
// resets on app restart by design (cold-start fallback uses sidebar order).
const DEFAULT_CAPACITY = 50;

export class WorkspaceMruStack {
	private entries: string[] = [];
	private readonly capacity: number;

	constructor(capacity: number = DEFAULT_CAPACITY) {
		this.capacity = Math.max(1, capacity);
	}

	/** Move id to position 0; dedupe; clamp to capacity. */
	touch(id: string) {
		if (!id) return;
		const existing = this.entries.indexOf(id);
		if (existing === 0) return;
		if (existing > 0) this.entries.splice(existing, 1);
		this.entries.unshift(id);
		if (this.entries.length > this.capacity) {
			this.entries.length = this.capacity;
		}
	}

	remove(id: string) {
		const idx = this.entries.indexOf(id);
		if (idx >= 0) this.entries.splice(idx, 1);
	}

	clear() {
		this.entries = [];
	}

	list(): readonly string[] {
		return this.entries;
	}

	size(): number {
		return this.entries.length;
	}
}
