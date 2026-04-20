import { describe, expect, test } from "bun:test";
import { createPushable } from "./pushable-iterable.js";

describe("createPushable", () => {
	test("delivers pushed values in FIFO order", async () => {
		const p = createPushable<number>();
		p.push(1);
		p.push(2);
		p.push(3);
		p.close();

		const out: number[] = [];
		for await (const v of p) out.push(v);
		expect(out).toEqual([1, 2, 3]);
	});

	test("waiter wakes up on push", async () => {
		const p = createPushable<string>();
		const it = p[Symbol.asyncIterator]();
		const nextPromise = it.next();
		p.push("hi");
		expect((await nextPromise).value).toBe("hi");
	});

	test("waiter resolves to done on close with empty queue", async () => {
		const p = createPushable<string>();
		const it = p[Symbol.asyncIterator]();
		const nextPromise = it.next();
		p.close();
		expect((await nextPromise).done).toBe(true);
	});

	test("pushes after close are ignored", async () => {
		const p = createPushable<number>();
		p.push(1);
		p.close();
		p.push(2);
		const out: number[] = [];
		for await (const v of p) out.push(v);
		expect(out).toEqual([1]);
	});

	test("break exits cleanly via return()", async () => {
		const p = createPushable<number>();
		p.push(1);
		p.push(2);
		let sum = 0;
		for await (const v of p) {
			sum += v;
			if (v === 2) break;
		}
		expect(sum).toBe(3);
		expect(p.closed).toBe(true);
	});
});
