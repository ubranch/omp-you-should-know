/** Pure logic: cadence, reply parsing, topic memory, transcript building, keys and card layout. */
import { visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

export const CHECK_EVERY = 6;
export const CLEAR_AFTER_PROMPTS = 2;
export const SEEN_KEEP_MS = 3 * 24 * 60 * 60 * 1000;
export const SEEN_MAX = 50;
/** The only two tags a card carries, as in Claude Code; anything that is not "heads up" becomes the default. */
export const DEFAULT_TAG = "You should know";
export const HEADS_UP = "Heads up";

/** turnIndex is 0-based and resets every agent run, so this fires after steps 6, 12, 18… of one run. */
export function isCheckTurn(turnIndex: number): boolean {
	return (turnIndex + 1) % CHECK_EVERY === 0;
}

/** Slash commands and `!` shell lines are submitted through the prompt box but are not prompts to the agent. */
export function isPrompt(text: string): boolean {
	return !/^[/!]/.test(text.trim());
}

export interface Finding {
	topic: string;
	tag: string;
	/** Written in the same reply as the topic, so "Learn more" opens without waiting. */
	explanation?: string;
}

const MAX_TOPIC_CHARS = 240;

// Strips bold and code marks only; underscores stay because identifiers like DATABASE_URL use them.
function cleanLine(text: string): string {
	return text
		.replace(/[*`]/g, "")
		.replace(/^["'“‘]+|["'”’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * `learn: none` → undefined. Otherwise `learn: <topic>`, optional `tag:`, optional `explain:` followed by the
 * explanation → a finding. A topic that wraps onto following lines is joined back. No `learn:` line throws.
 */
export function parseCheckReply(reply: string): Finding | undefined {
	const lines = reply.split(/\r?\n/);
	let topic: string | undefined;
	let tag: string | undefined;
	let explanation: string | undefined;
	let inTopic = false;
	for (const [i, raw] of lines.entries()) {
		const line = raw.replace(/[*`]/g, "");
		const match = /^\s*(learn|tag|explain)\s*:\s*(.*)$/i.exec(line);
		if (!match) {
			if (inTopic && line.trim()) topic = `${topic} ${line}`;
			else inTopic = false;
			continue;
		}
		const field = match[1]?.toLowerCase();
		inTopic = field === "learn" && topic === undefined;
		if (inTopic) topic = match[2] ?? "";
		else if (field === "tag") tag ??= cleanLine(match[2] ?? "");
		else if (field === "explain") {
			// The explanation is everything after `explain:`, raw, because it is Markdown.
			const sameLine = raw.replace(/^\s*\**explain\**\s*:\s*/i, "");
			explanation = [sameLine, ...lines.slice(i + 1)].join("\n").trim() || undefined;
			break;
		}
	}
	topic = topic === undefined ? undefined : cleanLine(topic);
	if (topic === undefined) throw new Error(`side agent reply has no "learn:" line: ${reply.slice(0, 200)}`);
	if (topic === "" || /^none\b/i.test(topic)) return undefined;
	if (topic.length > MAX_TOPIC_CHARS) throw new Error(`side agent topic is over ${MAX_TOPIC_CHARS} characters`);
	return {
		topic: /[.!?]$/.test(topic) ? topic : `${topic}.`,
		tag: tag && /^\W*heads[\s-]*up\W*$/i.test(tag) ? HEADS_UP : DEFAULT_TAG,
		explanation,
	};
}

export interface SeenTopic {
	topic: string;
	at: number;
}

export function topicKey(topic: string): string {
	return topic.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Drops topics older than three days and keeps the newest SEEN_MAX. */
export function pruneSeen(seen: readonly SeenTopic[], now: number): SeenTopic[] {
	return seen.filter(s => now - s.at < SEEN_KEEP_MS).slice(-SEEN_MAX);
}

export function wasSeen(seen: readonly SeenTopic[], topic: string): boolean {
	const key = topicKey(topic);
	return seen.some(s => topicKey(s.topic) === key);
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/** The subset of omp session entries the transcript reads. */
export interface TranscriptEntry {
	type: string;
	summary?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		isError?: boolean;
	};
}

const MAX_TOOL_ARGS = 300;
const MAX_TOOL_RESULT = 400;
const MAX_THINKING = 600;

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function partsOf(content: unknown): Array<Record<string, unknown>> {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function textOf(content: unknown): string {
	return partsOf(content)
		.map(p => (p.type === "text" ? String(p.text ?? "") : p.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function linesOf(entry: TranscriptEntry): string[] {
	if (entry.type === "compaction") return [`EARLIER (summary): ${entry.summary ?? ""}`];
	const message = entry.type === "message" ? entry.message : undefined;
	if (!message) return [];
	if (message.role === "user") return [`USER: ${textOf(message.content)}`];
	if (message.role === "toolResult") {
		const label = `RESULT ${message.toolName ?? "tool"}${message.isError ? " (error)" : ""}`;
		return [`${label}: ${clip(textOf(message.content), MAX_TOOL_RESULT)}`];
	}
	if (message.role !== "assistant") return [];
	const lines: string[] = [];
	for (const part of partsOf(message.content)) {
		if (part.type === "text" && String(part.text ?? "").trim()) lines.push(`AGENT: ${part.text}`);
		else if (part.type === "thinking") lines.push(`AGENT THINKING: ${clip(String(part.thinking ?? ""), MAX_THINKING)}`);
		else if (part.type === "toolCall")
			lines.push(`AGENT CALLS ${part.name}: ${clip(JSON.stringify(part.arguments ?? {}), MAX_TOOL_ARGS)}`);
	}
	return lines;
}

/**
 * Renders the branch from the last compaction onward. Over budget, it keeps the first user ask
 * and as much of the tail as fits.
 */
// ponytail: char budget, not tokens; switch to a tokenizer if smol models start overflowing.
export function buildTranscript(entries: readonly TranscriptEntry[], maxChars: number): string {
	let start = 0;
	entries.forEach((entry, i) => {
		if (entry.type === "compaction") start = i;
	});
	const lines = entries.slice(start).flatMap(linesOf);
	const full = lines.join("\n");
	if (full.length <= maxChars) return full;

	const firstAsk = lines.find(l => l.startsWith("USER: ") || l.startsWith("EARLIER ")) ?? "";
	const head = `${clip(firstAsk, Math.floor(maxChars / 4))}\n… (earlier steps omitted) …`;
	const tail: string[] = [];
	let used = head.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? "";
		if (used + line.length + 1 > maxChars) break;
		tail.unshift(line);
		used += line.length + 1;
	}
	return `${head}\n${tail.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Card states and keys
// ---------------------------------------------------------------------------

export type Depth = "first" | "simpler" | "shorter" | "more";

export type View =
	| { kind: "offer"; finding: Finding; promptsSince: number }
	| { kind: "explaining"; finding: Finding }
	| { kind: "explained"; finding: Finding; text: string }
	| { kind: "failed"; finding: Finding };

export type Action = "learn" | "know" | "dismiss" | "understood" | "chat" | Exclude<Depth, "first">;

const OFFER_KEYS: Record<string, Action> = { "1": "learn", "2": "know", "0": "dismiss" };
const EXPLAINED_KEYS: Record<string, Action> = {
	"1": "understood",
	"2": "chat",
	"3": "simpler",
	"4": "shorter",
	"5": "more",
	"0": "dismiss",
};

/**
 * The action a digit maps to in the current card state, if any. 3, 4 and 5 work on an explanation but are not drawn.
 * While an explanation is being written, and on the failed card, only 0 does anything.
 */
export function actionFor(view: View["kind"], digit: string): Action | undefined {
	if (view === "offer") return OFFER_KEYS[digit];
	if (view === "explained") return EXPLAINED_KEYS[digit];
	return digit === "0" ? "dismiss" : undefined;
}

// ---------------------------------------------------------------------------
// Card layout, cell for cell with Claude Code's terminal card:
//   ✦ Heads up · The sentence, wrapped with every
//     following line under the text.
//     1: Learn more   2: Knew this already   0: Dismiss
// ---------------------------------------------------------------------------

export const STAR = "✦";
const STAR_CELLS = 2;
const CHOICE_GAP = 3;

export interface Choice {
	key: string;
	label: string;
}

export const OFFER_CHOICES: readonly Choice[] = [
	{ key: "1", label: "Learn more" },
	{ key: "2", label: "Knew this already" },
	{ key: "0", label: "Dismiss" },
];
export const EXPLAINED_CHOICES: readonly Choice[] = [
	{ key: "1", label: "Understood" },
	{ key: "2", label: "Chat in main session" },
	{ key: "0", label: "Dismiss" },
];

/** Colours applied after layout, so widths are counted on plain text. */
export interface Ink {
	accent(text: string): string;
	dim(text: string): string;
}

/** `✦ tag · topic`, wrapped inside the star column's indent. */
export function leadLines(tag: string, topic: string, width: number, ink: Ink): string[] {
	return wrapTextWithAnsi(`${ink.dim(`${tag} ·`)} ${topic}`, Math.max(width - STAR_CELLS, 1)).map(
		(row, i) => `${i === 0 ? `${ink.accent(STAR)} ` : "  "}${row}`,
	);
}

/** The choice row, indented under the text, three cells between choices, wrapping when it does not fit. */
export function choiceLines(choices: readonly Choice[], width: number, ink: Ink): string[] {
	const lines: string[] = [];
	let line = "";
	let used = 0;
	for (const { key, label } of choices) {
		const cells = visibleWidth(`${key}: ${label}`);
		if (used > 0 && STAR_CELLS + used + CHOICE_GAP + cells > width) {
			lines.push(line);
			line = "";
			used = 0;
		}
		line += `${used > 0 ? " ".repeat(CHOICE_GAP) : " ".repeat(STAR_CELLS)}${ink.accent(`${key}:`)} ${label}`;
		used += (used > 0 ? CHOICE_GAP : 0) + cells;
	}
	if (line) lines.push(line);
	return lines;
}

/** The card left when the first explanation could not be written; 0 closes it. */
export function failedLine(ink: Ink): string {
	return `${ink.accent(STAR)} Couldn’t write that explanation ${ink.dim("·")} ${ink.accent("0:")} OK`;
}

/** Splits an explanation into Markdown text and fenced sketches; sketches are shown without their fences. */
export function splitSketches(text: string): Array<{ sketch: boolean; text: string }> {
	return text
		.split(/^```[^\n]*$/m)
		.map((part, i) => ({ sketch: i % 2 === 1, text: i % 2 === 1 ? part.replace(/^\n|\n$/g, "") : part.trim() }))
		.filter(part => part.text !== "");
}
