/** Pure logic: cadence, reply parsing, topic memory, transcript building, key mapping. No omp runtime imports. */

export const CHECK_EVERY = 6;
export const CLEAR_AFTER_PROMPTS = 2;
export const SEEN_KEEP_MS = 3 * 24 * 60 * 60 * 1000;
export const SEEN_MAX = 50;
export const DEFAULT_TAG = "Heads up";

/** turnIndex is 0-based and resets every agent run, so this fires after steps 6, 12, 18… of one run. */
export function isCheckTurn(turnIndex: number): boolean {
	return (turnIndex + 1) % CHECK_EVERY === 0;
}

export interface Finding {
	topic: string;
	tag: string;
}

const MAX_TOPIC_CHARS = 200;
const MAX_TAG_CHARS = 24;

// Strips bold and code marks only; underscores stay because identifiers like DATABASE_URL use them.
function cleanLine(text: string): string {
	return text
		.replace(/[*`]/g, "")
		.replace(/^["'“‘]+|["'”’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * `learn: none` → undefined. `learn: <topic>` plus optional `tag: <tag>` → a finding. A topic that wraps
 * onto following lines is joined back. Anything else throws.
 */
export function parseCheckReply(reply: string): Finding | undefined {
	let topic: string | undefined;
	let tag: string | undefined;
	let inTopic = false;
	for (const raw of reply.split(/\r?\n/)) {
		const line = raw.replace(/[*`]/g, "");
		const match = /^\s*(learn|tag)\s*:\s*(.*)$/i.exec(line);
		if (!match) {
			if (inTopic && line.trim()) topic = `${topic} ${line}`;
			else inTopic = false;
			continue;
		}
		inTopic = match[1]?.toLowerCase() === "learn" && topic === undefined;
		if (inTopic) topic = match[2] ?? "";
		else if (match[1]?.toLowerCase() === "tag") tag ??= cleanLine(match[2] ?? "");
	}
	topic = topic === undefined ? undefined : cleanLine(topic);
	if (topic === undefined) throw new Error(`side agent reply has no "learn:" line: ${reply.slice(0, 200)}`);
	if (topic === "" || /^none\b/i.test(topic)) return undefined;
	return {
		topic: topic.slice(0, MAX_TOPIC_CHARS),
		tag: tag ? tag.slice(0, MAX_TAG_CHARS) : DEFAULT_TAG,
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
	| { kind: "explained"; finding: Finding; text: string };

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

export const OFFER_CHOICES = "1: Learn more   2: Know this already   0: Dismiss";
export const EXPLAINED_CHOICES = "1: Understood   2: Chat in main session   3: Simpler   4: Shorter   5: More detail   0: Dismiss";

/** The action a digit maps to in the current card state, if any. */
export function actionFor(view: View["kind"], digit: string): Action | undefined {
	if (view === "offer") return OFFER_KEYS[digit];
	if (view === "explained") return EXPLAINED_KEYS[digit];
	return digit === "0" ? "dismiss" : undefined;
}
