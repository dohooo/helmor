import { describe, expect, it } from "vitest";
import { WorkspaceMruStack } from "./mru-stack";

describe("WorkspaceMruStack", () => {
	it("starts empty", () => {
		const mru = new WorkspaceMruStack();
		expect(mru.list()).toEqual([]);
		expect(mru.size()).toBe(0);
	});

	it("touch puts the id at index 0", () => {
		const mru = new WorkspaceMruStack();
		mru.touch("a");
		mru.touch("b");
		mru.touch("c");
		expect(mru.list()).toEqual(["c", "b", "a"]);
	});

	it("touch dedupes: re-touching an id moves it to the front", () => {
		const mru = new WorkspaceMruStack();
		mru.touch("a");
		mru.touch("b");
		mru.touch("c");
		mru.touch("a");
		expect(mru.list()).toEqual(["a", "c", "b"]);
		expect(mru.size()).toBe(3);
	});

	it("touch is a no-op when id is already at index 0", () => {
		const mru = new WorkspaceMruStack();
		mru.touch("a");
		mru.touch("a");
		mru.touch("a");
		expect(mru.list()).toEqual(["a"]);
	});

	it("ignores empty ids", () => {
		const mru = new WorkspaceMruStack();
		mru.touch("");
		expect(mru.list()).toEqual([]);
	});

	it("clamps to capacity, evicting oldest", () => {
		const mru = new WorkspaceMruStack(3);
		mru.touch("a");
		mru.touch("b");
		mru.touch("c");
		mru.touch("d");
		expect(mru.list()).toEqual(["d", "c", "b"]);
	});

	it("remove pulls an id from anywhere in the list", () => {
		const mru = new WorkspaceMruStack();
		mru.touch("a");
		mru.touch("b");
		mru.touch("c");
		mru.remove("b");
		expect(mru.list()).toEqual(["c", "a"]);
		mru.remove("missing");
		expect(mru.list()).toEqual(["c", "a"]);
	});

	it("clear empties the stack", () => {
		const mru = new WorkspaceMruStack();
		mru.touch("a");
		mru.touch("b");
		mru.clear();
		expect(mru.list()).toEqual([]);
	});
});
