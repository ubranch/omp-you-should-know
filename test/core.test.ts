import { describe, expect, test } from "bun:test";
import {
	actionFor,
	buildTranscript,
	choiceLines,
	DEFAULT_TAG,
	EXPLAINED_CHOICES,
	failedLine,
	HEADS_UP,
	type Ink,
	isCheckTurn,
	isPrompt,
	leadLines,
	OFFER_CHOICES,
	parseCheckReply,
	pruneSeen,
	SEEN_KEEP_MS,
	SEEN_MAX,
	splitSketches,
	type TranscriptEntry,
	wasSeen,
} from "../src/core.ts";
import { chatDraft } from "../src/prompts.ts";

const plain: Ink = { accent: s => s, dim: s => s };

test("checks after every sixth step of a run", () => {
	const fired = Array.from({ length: 19 }, (_, i) => i).filter(isCheckTurn);
	expect(fired).toEqual([5, 11, 17]);
});

describe("parseCheckReply", () => {
	test("none means nothing to show", () => {
		expect(parseCheckReply("learn: none")).toBeUndefined();
		expect(parseCheckReply("**learn:** None.")).toBeUndefined();
	});

	test("reads topic, tag and explanation, stripping markdown and quotes", () => {
		expect(
			parseCheckReply('**learn:** "The agent deleted the old migration."\ntag: `Heads up`\nexplain:\n**Old migration gone**\n\nBody.'),
		).toEqual({
			topic: "The agent deleted the old migration.",
			tag: HEADS_UP,
			explanation: "**Old migration gone**\n\nBody.",
		});
	});

	test("only Heads up and You should know are tags; anything else is the default", () => {
		expect(parseCheckReply("learn: x.\ntag: heads-up!")?.tag).toBe(HEADS_UP);
		expect(parseCheckReply("learn: x.\ntag: Risk")?.tag).toBe(DEFAULT_TAG);
		expect(parseCheckReply("learn: x.")?.tag).toBe(DEFAULT_TAG);
	});

	test("keeps underscores in identifiers and ends the topic with a period", () => {
		expect(parseCheckReply("learn: Two tests skipped because DATABASE_URL is unset")?.topic).toBe(
			"Two tests skipped because DATABASE_URL is unset.",
		);
	});

	test("joins a topic that wraps onto the next line", () => {
		expect(parseCheckReply("learn: Two payment tests were skipped, even though\nthe agent called the run green.\ntag: Heads up")).toEqual({
			topic: "Two payment tests were skipped, even though the agent called the run green.",
			tag: HEADS_UP,
			explanation: undefined,
		});
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

describe("card layout matches Claude Code's terminal card", () => {
	const topic =
		"The new omp extension now runs in every omp session, including herdr fleet worker panes where nobody reads the cards.";

	test("star column, dim tag, hanging indent", () => {
		expect(leadLines(HEADS_UP, topic, 120, plain)).toEqual([
			"✦ Heads up · The new omp extension now runs in every omp session, including herdr fleet worker panes where nobody reads",
			"  the cards.",
		]);
	});

	test("colours wrap the star, the tag and the digits only", () => {
		const ink: Ink = { accent: s => `<a>${s}</a>`, dim: s => `<d>${s}</d>` };
		expect(leadLines(HEADS_UP, "Short.", 80, ink)).toEqual(["<a>✦</a> <d>Heads up ·</d> Short."]);
		expect(choiceLines(OFFER_CHOICES, 80, ink)).toEqual(["  <a>1:</a> Learn more   <a>2:</a> Knew this already   <a>0:</a> Dismiss"]);
	});

	test("choices sit under the text, three cells apart, and wrap when narrow", () => {
		expect(choiceLines(OFFER_CHOICES, 120, plain)).toEqual(["  1: Learn more   2: Knew this already   0: Dismiss"]);
		expect(choiceLines(EXPLAINED_CHOICES, 120, plain)).toEqual(["  1: Understood   2: Chat in main session   0: Dismiss"]);
		expect(choiceLines(OFFER_CHOICES, 30, plain)).toEqual(["  1: Learn more", "  2: Knew this already", "  0: Dismiss"]);
	});

	test("a failed first explanation leaves one line with its only choice", () => {
		expect(failedLine(plain)).toBe("✦ Couldn’t write that explanation · 0: OK");
		expect(actionFor("failed", "0")).toBe("dismiss");
		expect(actionFor("failed", "1")).toBeUndefined();
	});

	test("sketches lose their fences", () => {
		expect(splitSketches("**T**\n\nText.\n```text\na\n b\n```\nAfter.")).toEqual([
			{ sketch: false, text: "**T**\n\nText." },
			{ sketch: true, text: "a\n b" },
			{ sketch: false, text: "After." },
		]);
	});
});

test("chat draft quotes the card and its explanation, then leaves a line to type on", () => {
	expect(chatDraft({ topic: "Two tests skipped.", tag: HEADS_UP }, "**Tests skipped**\n\nBody.")).toBe(
		"Here is a note offered by a side agent:\n\n> Heads up · Two tests skipped.\n>\n> **Tests skipped**\n>\n> Body.\n\n",
	);
});

test("slash commands and shell lines are not prompts", () => {
	expect(isPrompt("/ysk")).toBe(false);
	expect(isPrompt("  /ysk 1")).toBe(false);
	expect(isPrompt("!ls")).toBe(false);
	expect(isPrompt("fix the login")).toBe(true);
});
