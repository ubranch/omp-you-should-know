import { describe, expect, test } from "bun:test";
import {
	actionFor,
	buildTranscript,
	DEFAULT_TAG,
	isCheckTurn,
	parseCheckReply,
	pruneSeen,
	SEEN_KEEP_MS,
	SEEN_MAX,
	type TranscriptEntry,
	wasSeen,
} from "../src/core.ts";

test("checks after every sixth step of a run", () => {
	const fired = Array.from({ length: 19 }, (_, i) => i).filter(isCheckTurn);
	expect(fired).toEqual([5, 11, 17]);
});

describe("parseCheckReply", () => {
	test("none means nothing to show", () => {
		expect(parseCheckReply("learn: none")).toBeUndefined();
		expect(parseCheckReply("**learn:** None.")).toBeUndefined();
	});

	test("reads topic and tag, stripping markdown and quotes", () => {
		expect(parseCheckReply('**learn:** "The agent deleted the old migration."\ntag: `Risk`')).toEqual({
			topic: "The agent deleted the old migration.",
			tag: "Risk",
		});
	});

	test("keeps underscores in identifiers", () => {
		expect(parseCheckReply("learn: Two tests skipped because DATABASE_URL is unset")?.topic).toBe(
			"Two tests skipped because DATABASE_URL is unset",
		);
	});

	test("joins a topic that wraps onto the next line", () => {
		expect(parseCheckReply("learn: Two payment tests were skipped, even though\nthe agent called the run green.\ntag: Risk")).toEqual({
			topic: "Two payment tests were skipped, even though the agent called the run green.",
			tag: "Risk",
		});
	});

	test("tag defaults to Heads up", () => {
		expect(parseCheckReply("learn: Tests were skipped")?.tag).toBe(DEFAULT_TAG);
	});

	test("a reply without a learn line is an error, not silence", () => {
		expect(() => parseCheckReply("I think everything is fine.")).toThrow(/no "learn:" line/);
	});
});

describe("seen topics", () => {
	const now = 10 * SEEN_KEEP_MS;

	test("expire after three days and cap at SEEN_MAX", () => {
		expect(pruneSeen([{ topic: "old", at: now - SEEN_KEEP_MS }], now)).toEqual([]);
		const many = Array.from({ length: SEEN_MAX + 5 }, (_, i) => ({ topic: `t${i}`, at: now }));
		const kept = pruneSeen(many, now);
		expect(kept).toHaveLength(SEEN_MAX);
		expect(kept[0]?.topic).toBe("t5");
	});

	test("match ignoring case and punctuation", () => {
		expect(wasSeen([{ topic: "Prompt caching costs MORE!", at: now }], "prompt caching costs more")).toBe(true);
		expect(wasSeen([{ topic: "something else", at: now }], "prompt caching costs more")).toBe(false);
	});
});

describe("buildTranscript", () => {
	const user = (text: string): TranscriptEntry => ({ type: "message", message: { role: "user", content: text } });

	test("renders messages, tool calls and failed tool results", () => {
		const out = buildTranscript(
			[
				user("fix the login"),
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "Looking." },
							{ type: "toolCall", name: "bash", arguments: { command: "rm -rf dist" } },
						],
					},
				},
				{ type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "denied" }] } },
			],
			10_000,
		);
		expect(out).toBe(
			'USER: fix the login\nAGENT: Looking.\nAGENT CALLS bash: {"command":"rm -rf dist"}\nRESULT bash (error): denied',
		);
	});

	test("starts at the last compaction", () => {
		const out = buildTranscript([user("before"), { type: "compaction", summary: "did things" }, user("after")], 10_000);
		expect(out).toBe("EARLIER (summary): did things\nUSER: after");
	});

	test("over budget keeps the first ask and the newest tail", () => {
		const entries = [user("the original ask"), ...Array.from({ length: 50 }, (_, i) => user(`step ${i} ${"x".repeat(40)}`))];
		const out = buildTranscript(entries, 400);
		expect(out.length).toBeLessThanOrEqual(400);
		expect(out.startsWith("USER: the original ask\n… (earlier steps omitted) …")).toBe(true);
		expect(out.endsWith(`USER: step 49 ${"x".repeat(40)}`)).toBe(true);
	});
});

test("digits map to the current card's choices", () => {
	expect(actionFor("offer", "1")).toBe("learn");
	expect(actionFor("offer", "3")).toBeUndefined();
	expect(actionFor("explained", "2")).toBe("chat");
	expect(actionFor("explained", "5")).toBe("more");
	expect(actionFor("explaining", "1")).toBeUndefined();
	expect(actionFor("explaining", "0")).toBe("dismiss");
});
