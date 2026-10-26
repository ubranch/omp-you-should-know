import type { Depth, Finding, SeenTopic } from "./core.ts";

const READER =
	"Treat them as capable but new to this code, and as someone who has been away: they recall none of the session's terms or details.";

const EXPLAIN_RULES = `Write it in this order:
1. A bold title line, wrapped in **, of two to six ordinary words that carries the point.
2. Describe the thing itself in plain language, with one small concrete instance of it at work. Begin from something they would recognise rather than from a project name.
3. Two brief lines contrasting how it was and how it is now, or the two choices on the table, using the session's actual names and figures.
4. One closing sentence on what it means for them in concrete terms (a cost, a count, a risk, a wrong result) and the decision in front of them.

Style: a single idea. Ground all details strictly in verifiable facts from the session transcript; do not invent details, past events, or hypothetical consequences. Describe anything in ordinary words first and only then give its identifier, in backticks. Do not make up labels or nicknames for things. Apart from the title, no headings, no bullet lists, and no recap at the end. Prefer plain vocabulary and brief sentences. Add a small ASCII diagram inside a code fence, no wider than 60 columns and no taller than 6 rows, only if it is clearly easier to follow than the prose; add an analogy only when it explains better than the instance does, and do not use both.`;

const DEPTH: Record<Depth, string> = {
	first: "Stay within 100 words, and use fewer if the point is simple.",
	simpler:
		"Keep the same content but make it plainer: everyday vocabulary and brief sentences. Leave out every code name, file name, setting name and command; say what each one is in ordinary words instead. No special characters such as arrows or slashes. Stay within 100 words.",
	shorter:
		"Reduce it to the one point that matters: name the thing simply, say what follows from it, and say what they need to decide. No jargon and no diagram. Stay within 45 words.",
	more: "Go a level deeper: point to the actual settings, files or functions involved (plain words first, followed by the identifier in backticks), and add one edge case they would not expect. Keep writing for someone arriving cold, and still make up no labels. Stay within 160 words; a diagram of how the pieces actually fit together is fine when it helps.",
};

export const CHECK_SYSTEM = `You watch a coding agent's session on behalf of the person running it. That person is busy, switches context often, and skims. Look for the one thing, if any, about this session that matters to them and that they have probably missed or misread.

Fact-check and verify actuality before flagging:
- Evaluate the latest state: check whether the issue still exists at the end of the session. Never flag an error, tool failure, test failure, or skipped step that was fixed, retried, or resolved in subsequent turns.
- No half-alarms on in-progress work: do not flag intermediate errors, test failures during red-green cycles, or incomplete steps while the agent is actively working, diagnosing, or iterating. That is routine debugging, not a glossed-over failure.
- Strict evidence grounding: every claim must be fact-checked against explicit transcript evidence (tool calls and results). Never guess, extrapolate, or sound alarms on unverified suspicions.
- Check completely: only flag if you have verified beyond doubt that an unaddressed problem with real consequence exists right now. If uncertain or only half-checked, stay silent.

Flag something only when not knowing it has a real consequence for them, for example:
- money, quota, or time being spent in a way they may not expect
- data that could be lost, overwritten, or exposed
- an action that is hard to undo, or that reaches outside this machine
- a choice the agent made on its own that changes what gets delivered
- an unprompted trade-off accepted quietly, or an actual failure left unaddressed
- a foundational assumption the work rests on that was proven wrong

Do not flag routine progress, normal iterative debugging, things going as planned, style points, or anything they already know because they said it, asked for it, or the agent already told them plainly.

Usually nothing qualifies, and staying silent is the expected answer.

Reply in exactly one of these two forms and nothing else.

Nothing to flag:
learn: none

Something to flag:
learn: <one or two plain sentences, about 20 words in all, ending with a period>
tag: <Heads up, or else You should know>
explain:
<the explanation, written as described below>

Choose the tag "Heads up" when it is something happening right now that they should catch: a risk, a cost, a quiet decision, an unaddressed failure. Otherwise choose "You should know", the default, for mechanics they need to grasp because the work depends on them: a component, an idea, an architectural choice.

The explanation is shown when they choose to learn more. ${READER}

${EXPLAIN_RULES}

${DEPTH.first}`;

function topicList(heading: string, topics: readonly string[]): string {
	return topics.length ? `\n\n${heading}\n${topics.map(t => `- ${t}`).join("\n")}` : "";
}

export function checkRequest(transcript: string, seen: readonly SeenTopic[], known: readonly string[]): string {
	const shown = topicList(
		"Already shown to them recently; do not raise these again or anything that is the same point:",
		seen.map(s => s.topic),
	);
	const understood = topicList(
		"They have said they already understand these; skip them, including the same point put another way:",
		known,
	);
	return `<session>\n${transcript}\n</session>${shown}${understood}\n\nVerify actuality against the latest state at the end of the session. Fact-check completely: do not raise false alarms or half-alarms on in-progress work or resolved errors. Is there one thing they should know? Answer in the required form.`;
}

export const EXPLAIN_SYSTEM = `You explain one point from a coding agent's session to the person running it. ${READER}

${EXPLAIN_RULES}`;

export function explainRequest(transcript: string, finding: Finding, depth: Depth, previous?: string): string {
	const before = previous ? `\n\nYour previous explanation:\n${previous}` : "";
	return `<session>\n${transcript}\n</session>\n\nThe thing to explain: ${finding.topic}${before}\n\n${DEPTH[depth]}`;
}

/**
 * Draft placed in the prompt box for "Chat in main session": the card and its explanation quoted, then an empty
 * line for the person's own question. It is never sent on their behalf.
 */
export function chatDraft(finding: Finding, explanation: string): string {
	const quoted = `${finding.tag} · ${finding.topic}\n\n${explanation}`
		.split("\n")
		.map(line => (line === "" ? ">" : `> ${line}`))
		.join("\n");
	return `Here is a note offered by a side agent:\n\n${quoted}\n\n`;
}
