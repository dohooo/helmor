// bun:sqlite-backed sqlite3 shim. Replaces the native `sqlite3` npm package
// at build time so `bun build --compile` doesn't try to load the `.node`
// addon (which fails inside the compiled bun virtual FS).
//
// node-sqlite3 supports variadic params + an optional trailing callback:
//   db.run(sql, p1, p2, ..., cb?)
//   db.run(sql, [paramsArr], cb?)
//   db.run(sql, {named: ...}, cb?)
// We mirror that contract; mishandling it (e.g. treating param 2 as the
// callback) breaks @cursor/sdk's local run-store, which silently hangs the
// promise chain and prevents the agent stream from completing.

import { Database as BunDB } from "bun:sqlite";
import EventEmitter from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const isFn = (x) => typeof x === "function";
const toError = (e) => (e instanceof Error ? e : new Error(String(e)));

function parseSqlArgs(args) {
	let callback;
	if (args.length > 0 && isFn(args[args.length - 1])) {
		callback = args[args.length - 1];
		args = args.slice(0, -1);
	}
	let params;
	if (args.length === 0) params = undefined;
	else if (args.length === 1) params = args[0];
	else params = args;
	return [params, callback];
}

// each(sql, ...params, rowCb, completeCb?)
function parseEachArgs(args) {
	let completeCb;
	let rowCb;
	if (
		args.length >= 2 &&
		isFn(args[args.length - 1]) &&
		isFn(args[args.length - 2])
	) {
		completeCb = args[args.length - 1];
		rowCb = args[args.length - 2];
		args = args.slice(0, -2);
	} else if (args.length >= 1 && isFn(args[args.length - 1])) {
		rowCb = args[args.length - 1];
		args = args.slice(0, -1);
	}
	let params;
	if (args.length === 0) params = undefined;
	else if (args.length === 1) params = args[0];
	else params = args;
	return [params, rowCb, completeCb];
}

class Statement extends EventEmitter {
	constructor(stmt) {
		super();
		this._stmt = stmt;
	}

	run(...args) {
		const [params, callback] = parseSqlArgs(args);
		queueMicrotask(() => {
			try {
				params !== undefined ? this._stmt.run(params) : this._stmt.run();
				if (isFn(callback)) callback.call(this, null);
			} catch (e) {
				if (isFn(callback)) callback.call(this, toError(e));
			}
		});
		return this;
	}

	get(...args) {
		const [params, callback] = parseSqlArgs(args);
		queueMicrotask(() => {
			try {
				const row =
					params !== undefined ? this._stmt.get(params) : this._stmt.get();
				if (isFn(callback)) callback.call(this, null, row);
			} catch (e) {
				if (isFn(callback)) callback.call(this, toError(e));
			}
		});
		return this;
	}

	all(...args) {
		const [params, callback] = parseSqlArgs(args);
		queueMicrotask(() => {
			try {
				const rows =
					params !== undefined ? this._stmt.all(params) : this._stmt.all();
				if (isFn(callback)) callback.call(this, null, rows);
			} catch (e) {
				if (isFn(callback)) callback.call(this, toError(e));
			}
		});
		return this;
	}

	each(...args) {
		const [params, rowCb, doneCb] = parseEachArgs(args);
		queueMicrotask(() => {
			try {
				const rows =
					params !== undefined ? this._stmt.all(params) : this._stmt.all();
				for (const row of rows) {
					if (isFn(rowCb)) rowCb.call(this, null, row);
				}
				if (isFn(doneCb)) doneCb.call(this, null);
			} catch (e) {
				const err = toError(e);
				if (isFn(doneCb)) doneCb.call(this, err);
				else if (isFn(rowCb)) rowCb.call(this, err);
			}
		});
		return this;
	}

	finalize(cb) {
		queueMicrotask(() => {
			try {
				this._stmt.finalize();
				if (isFn(cb)) cb.call(this, null);
			} catch (e) {
				if (isFn(cb)) cb.call(this, toError(e));
			}
		});
		return this;
	}

	bind(...args) {
		const callback = isFn(args[args.length - 1])
			? args[args.length - 1]
			: undefined;
		queueMicrotask(() => {
			if (isFn(callback)) callback.call(this, null);
		});
		return this;
	}

	reset(cb) {
		queueMicrotask(() => {
			if (isFn(cb)) cb.call(this, null);
		});
		return this;
	}
}

class Database extends EventEmitter {
	constructor(filename, modeOrCb, cb) {
		super();
		const callback = isFn(modeOrCb) ? modeOrCb : cb;
		try {
			if (filename !== ":memory:") {
				const dir = dirname(filename);
				if (dir && dir !== "." && !existsSync(dir))
					mkdirSync(dir, { recursive: true });
			}
			this._db = new BunDB(filename);
			this.open = true;
			queueMicrotask(() => {
				if (isFn(callback)) callback.call(this, null);
				this.emit("open");
			});
		} catch (e) {
			this.open = false;
			const err = toError(e);
			queueMicrotask(() => {
				if (isFn(callback)) callback.call(this, err);
				this.emit("error", err);
			});
		}
	}

	run(sql, ...args) {
		const [params, callback] = parseSqlArgs(args);
		queueMicrotask(() => {
			try {
				const stmt = this._db.prepare(sql);
				params !== undefined ? stmt.run(params) : stmt.run();
				if (isFn(callback)) callback.call(this, null);
			} catch (e) {
				if (isFn(callback)) callback.call(this, toError(e));
			}
		});
		return this;
	}

	get(sql, ...args) {
		const [params, callback] = parseSqlArgs(args);
		queueMicrotask(() => {
			try {
				const stmt = this._db.prepare(sql);
				const row = params !== undefined ? stmt.get(params) : stmt.get();
				if (isFn(callback)) callback.call(this, null, row);
			} catch (e) {
				if (isFn(callback)) callback.call(this, toError(e));
			}
		});
		return this;
	}

	all(sql, ...args) {
		const [params, callback] = parseSqlArgs(args);
		queueMicrotask(() => {
			try {
				const stmt = this._db.prepare(sql);
				const rows = params !== undefined ? stmt.all(params) : stmt.all();
				if (isFn(callback)) callback.call(this, null, rows);
			} catch (e) {
				if (isFn(callback)) callback.call(this, toError(e));
			}
		});
		return this;
	}

	each(sql, ...args) {
		const [params, rowCb, doneCb] = parseEachArgs(args);
		queueMicrotask(() => {
			try {
				const stmt = this._db.prepare(sql);
				const rows = params !== undefined ? stmt.all(params) : stmt.all();
				for (const row of rows) {
					if (isFn(rowCb)) rowCb.call(this, null, row);
				}
				if (isFn(doneCb)) doneCb.call(this, null);
			} catch (e) {
				const err = toError(e);
				if (isFn(doneCb)) doneCb.call(this, err);
				else if (isFn(rowCb)) rowCb.call(this, err);
			}
		});
		return this;
	}

	prepare(sql, ...args) {
		const callback = isFn(args[args.length - 1])
			? args[args.length - 1]
			: undefined;
		try {
			const stmt = new Statement(this._db.prepare(sql));
			if (isFn(callback)) queueMicrotask(() => callback.call(stmt, null));
			return stmt;
		} catch (e) {
			const err = toError(e);
			if (isFn(callback)) queueMicrotask(() => callback.call(this, err));
			throw err;
		}
	}

	exec(sql, cb) {
		queueMicrotask(() => {
			try {
				this._db.exec(sql);
				if (isFn(cb)) cb.call(this, null);
			} catch (e) {
				if (isFn(cb)) cb.call(this, toError(e));
			}
		});
		return this;
	}

	close(cb) {
		queueMicrotask(() => {
			try {
				this._db.close();
				this.open = false;
				if (isFn(cb)) cb.call(this, null);
			} catch (e) {
				if (isFn(cb)) cb.call(this, toError(e));
			}
		});
	}

	serialize(cb) {
		if (isFn(cb)) cb();
	}
	parallelize(cb) {
		if (isFn(cb)) cb();
	}
	configure() {}
}

const sqlite3 = {
	Database,
	Statement,
	cached: { Database, objects: {} },
	verbose() {
		return sqlite3;
	},
	OPEN_READONLY: 0x1,
	OPEN_READWRITE: 0x2,
	OPEN_CREATE: 0x4,
	OPEN_FULLMUTEX: 0x10000,
	OPEN_URI: 0x40,
	OPEN_SHAREDCACHE: 0x20000,
	OPEN_PRIVATECACHE: 0x40000,
};

export default sqlite3;
export { Database, Statement };
export const cached = sqlite3.cached;
export const verbose = sqlite3.verbose;
export const OPEN_READONLY = sqlite3.OPEN_READONLY;
export const OPEN_READWRITE = sqlite3.OPEN_READWRITE;
export const OPEN_CREATE = sqlite3.OPEN_CREATE;
export const OPEN_FULLMUTEX = sqlite3.OPEN_FULLMUTEX;
export const OPEN_URI = sqlite3.OPEN_URI;
export const OPEN_SHAREDCACHE = sqlite3.OPEN_SHAREDCACHE;
export const OPEN_PRIVATECACHE = sqlite3.OPEN_PRIVATECACHE;
