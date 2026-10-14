import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/extension-host.mjs", import.meta.url));
type Provider = "google" | "google-antigravity";
type Scenario =
	| "reasoning" | "token-budget" | "pacing" | "cooldown" | "http-429" | "http-402"
	| "warning-reset" | "first-event" | "cancel-pacing" | "switch" | "shutdown"
	| "stale-goal" | "pending-boundaries" | "pending-explanation" | "context" | "cache-duplicate"
	| "cache-inputs" | "cache-model" | "cache-header-config" | "cache-lifecycle" | "cache-error" | "cache-malformed" | "cache-memory";
interface GoogleRequest {
	contents: { role: string; parts: { text?: string }[] }[];
	generationConfig: {
		maxOutputTokens?: number;
		thinkingConfig?: { includeThoughts: boolean; thinkingLevel: string };
	};
}
type ReceivedRequest = {
	receivedAt: number;
	repliedAt?: number;
	rateLimited: boolean;
	fixtureStaticHeader: string | null;
	fixtureResolvedHeader: string | null;
} & (
		| { provider: "google"; body: GoogleRequest }
		| { provider: "google-antigravity"; body: { model: string; request: GoogleRequest } }
	);
interface FixtureResult {
	notifications: { message: string; kind: string; sessionId: string }[];
	cards: string[][];
	currentCard: string[];
	requests: ReceivedRequest[];
	transportAborted: boolean[];
	paced: boolean;
	resolverCalls: number;
	headerResolutionCount: number;
	cardsAfterNewGoal: string[][];
	cachedCheckImmediate: boolean;
}

function expectNoFinding(result: FixtureResult, completed: number) {
	expect(result.notifications.filter(n => n.kind === "error")).toEqual([]);
	expect(result.notifications.filter(n => n.message.includes("nothing worth flagging"))).toHaveLength(completed);
	expect(result.currentCard).toEqual([]);
}

function requestText(request: ReceivedRequest): string {
	const body = request.provider === "google" ? request.body : request.body.request;
	return body.contents.flatMap(content => content.parts.map(part => part.text ?? "")).join("\n");
}

function sessionText(request: ReceivedRequest): string {
	const text = requestText(request);
	const context = /<session>\n([\s\S]*?)\n<\/session>/.exec(text);
	if (!context) throw new Error(`No session context in actual provider request: ${text}`);
	return context[1]!;
}

function expectPacedMisses(requests: ReceivedRequest[]) {
	for (let i = 1; i < requests.length; i++) {
		expect(requests[i]!.receivedAt - requests[i - 1]!.receivedAt).toBeGreaterThanOrEqual(4_900);
	}
}

async function reproduce(scenario: Scenario, provider: Provider = "google-antigravity"): Promise<FixtureResult> {
	const root = await mkdtemp(join(tmpdir(), "ysk-e2e-"));
	const child = Bun.spawn([process.execPath, fixture, scenario, provider], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			TEMP: root,
			TMP: root,
			HOME: root,
			USERPROFILE: root,
			PI_CODING_AGENT_DIR: join(root, "agent"),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			NO_COLOR: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const deadline = setTimeout(() => child.kill(), 25_000);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr: exitCode === 0 ? "" : stderr, stdout: exitCode === 0 ? "" : stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "" });
		const result: FixtureResult = JSON.parse(stdout);
		return result;
	} finally {
		clearTimeout(deadline);
		child.kill();
		await rm(root, { recursive: true, force: true });
	}
}

const providers: Provider[] = ["google", "google-antigravity"];
for (const provider of providers) {
	test(`${provider}: automatic check and /ysk explanation request high reasoning on the real wire`, async () => {
		const result = await reproduce("reasoning", provider);
		expect(result.notifications.filter(n => n.kind === "error")).toEqual([]);
		expect(result.currentCard.join("\n")).toContain("The database migration was not tested.");
		expect(result.currentCard.join("\n")).toContain("Run the database migration test before deploying.");
		const generationConfig = { thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } };
		const body = provider === "google"
			? { generationConfig }
			: { model: "gemini-3.8-flash-high", request: { generationConfig } };
		expect(result).toMatchObject({ requests: [{ body }, { body }] });
	}, 30_000);
}

test("Antigravity Gemini 3.8 High completes /ysk check with enough token budget", async () => {
	const result = await reproduce("token-budget");
	expectNoFinding(result, 1);
	expect(result.requests).toHaveLength(1);
	expect(result).toMatchObject({
		requests: [{ rateLimited: false }],
		transportAborted: [false],
	});
}, 30_000);

test("completed /ysk checks queue behind request pacing instead of hitting capacity", async () => {
	const result = await reproduce("pacing");
	expectNoFinding(result, 2);
	expect(result).toMatchObject({
		requests: [{ rateLimited: false }, { rateLimited: false }],
		paced: true,
	});
}, 30_000);

test("a capacity failure sets cooldown and the next /ysk check sends no HTTP request", async () => {
	const result = await reproduce("cooldown");
	expect(result.notifications.filter(n => n.kind === "error")).toHaveLength(2);
	expect(result.notifications.filter(n => n.message.includes("nothing worth flagging"))).toHaveLength(1);
	expect(result).toMatchObject({
		requests: [{ rateLimited: false }, { rateLimited: true }],
		currentCard: [],
	});
}, 30_000);

const opaqueStatuses: (429 | 402)[] = [429, 402];
for (const status of opaqueStatuses) {
	test(`opaque Google HTTP ${status} sets cooldown without resubmitting the next /ysk check`, async () => {
		const result = await reproduce(`http-${status}`, "google");
		const errors = result.notifications.filter(n => n.kind === "error");
		expect(errors).toHaveLength(2);
		for (const error of errors) {
			expect(error.message).toContain("cooling down");
			expect(error.message).toMatch(/\b[1-9]\d* s\b/);
		}
		expect(result.notifications.filter(n => n.message.includes("nothing worth flagging"))).toHaveLength(1);
		expect(result).toMatchObject({
			requests: [{ rateLimited: false }, { rateLimited: true }],
			currentCard: [],
		});
	}, 30_000);
}

test("automatic warnings reset on session switch after an opaque HTTP failure", async () => {
	const result = await reproduce("warning-reset", "google");
	expect(result.notifications.filter(n => n.kind === "error").map(n => n.sessionId)).toEqual([
		"fixture-session-a",
		"fixture-session-b",
	]);
	expect(result).toMatchObject({
		requests: [{ rateLimited: false }, { rateLimited: false }],
		currentCard: [],
		paced: true,
	});
}, 30_000);

test("/ysk off cancels a pacing wait without sending its delayed request", async () => {
	const result = await reproduce("cancel-pacing");
	expectNoFinding(result, 2);
	expect(result).toMatchObject({
		requests: [{ rateLimited: false }, { rateLimited: false }],
		currentCard: [],
	});
}, 30_000);

const lifecycleScenarios: Scenario[] = ["switch", "shutdown"];
for (const scenario of lifecycleScenarios) {
	test(`session ${scenario} aborts a pending real request and prevents a stale card`, async () => {
		const result = await reproduce(scenario);
		expect(result.notifications.filter(n => n.kind === "error")).toEqual([]);
		expect(result.cards.every(card => card.length === 0)).toBe(true);
		expect(result).toMatchObject({
			transportAborted: [true],
			currentCard: [],
			requests: [{ rateLimited: false }],
		});
	}, 30_000);
}

test("the plugin deadline owns a slow first event instead of the provider watchdog", async () => {
	const result = await reproduce("first-event");
	expectNoFinding(result, 1);
	expect(result).toMatchObject({
		requests: [{ rateLimited: false }],
		transportAborted: [false],
	});
}, 30_000);

test("optimization: an accepted new user goal rejects the pending old check and its topic memory", async () => {
	const result = await reproduce("stale-goal");
	expect(result.notifications.filter(n => n.kind === "error")).toEqual([]);
	expect(result.cardsAfterNewGoal.every(card => card.length === 0)).toBe(true);
	expect(result.requests).toHaveLength(2);
	expect(sessionText(result.requests[0]!)).toContain("Deploy the database migration.");
	expect(sessionText(result.requests[1]!)).toContain("NEW_GOAL: Audit the migration rollback instead of deploying.");
	expect(requestText(result.requests[1]!)).not.toContain("The database migration was not tested.");
	expect(result.currentCard.join("\n")).toContain("The database migration was not tested.");
}, 30_000);

test("optimization: ordinary tool turns and slash card input leave a pending check usable", async () => {
	const result = await reproduce("pending-boundaries");
	expectNoFinding(result, 1);
	expect(result.requests).toHaveLength(1);
	expect(result.transportAborted).toEqual([false]);
}, 30_000);

test("optimization: an accepted user goal preserves a requested explanation and rewrites remain uncached", async () => {
	const result = await reproduce("pending-explanation");
	expect(result.notifications.filter(n => n.kind === "error")).toEqual([]);
	expect(result.requests).toHaveLength(3);
	expect(result.transportAborted).toEqual([false, false, false]);
	expect(result.currentCard.join("\n")).toContain("Run the database migration test before deploying.");
	expect(sessionText(result.requests[2]!)).toContain("Explain how to verify rollback readiness.");
	expectPacedMisses(result.requests);
}, 30_000);

test("optimization: bounded real-wire context retains middle user instructions and the latest compaction", async () => {
	const result = await reproduce("context");
	expectNoFinding(result, 2);
	expect(result.requests).toHaveLength(2);
	const context = sessionText(result.requests[0]!);
	const goals = [
		"INITIAL_GOAL: Prepare a reversible database migration.",
		"MIDDLE_INSTRUCTION: Never deploy before the rollback test passes.",
		"LATEST_REQUEST: Show the rollback test result.",
	];
	for (const goal of goals) expect(context).toContain(goal);
	expect(context.indexOf(goals[0]!)).toBeLessThan(context.indexOf(goals[1]!));
	expect(context.indexOf(goals[1]!)).toBeLessThan(context.indexOf(goals[2]!));
	expect(context.length).toBeLessThanOrEqual(48_000);
	const compacted = sessionText(result.requests[1]!);
	expect(compacted).not.toContain("OBSOLETE_GOAL");
	expect(compacted).toContain("COMPACTED_GOAL: Keep the deployment reversible.");
	expect(compacted).toContain("OVERSIZED_INSTRUCTION: Require rollback proof.");
	expect(compacted).toContain("AFTER_COMPACTION_REQUEST: Report rollback readiness.");
	expect(compacted.indexOf("COMPACTED_GOAL")).toBeLessThan(compacted.indexOf("OVERSIZED_INSTRUCTION"));
	expect(compacted.indexOf("OVERSIZED_INSTRUCTION")).toBeLessThan(compacted.indexOf("AFTER_COMPACTION_REQUEST"));
	expect(compacted.length).toBeLessThanOrEqual(48_000);
}, 30_000);

test("optimization: an identical completed check returns two visible results with one provider request", async () => {
	const result = await reproduce("cache-duplicate");
	expectNoFinding(result, 2);
	expect(result.requests).toHaveLength(1);
	expect(result.resolverCalls).toBe(1);
	expect(result.cachedCheckImmediate).toBe(true);
}, 30_000);

test("optimization: changed user and tool context miss the completed cache and retain pacing", async () => {
	const result = await reproduce("cache-inputs");
	expectNoFinding(result, 3);
	expect(result.requests).toHaveLength(3);
	expect(sessionText(result.requests[0]!)).not.toContain("CHANGED_USER_GOAL");
	expect(sessionText(result.requests[1]!)).toContain("CHANGED_USER_GOAL: Verify rollback before deployment.");
	expect(sessionText(result.requests[1]!)).not.toContain("Migration test attempt");
	expect(sessionText(result.requests[2]!)).toContain("RESULT bash: Migration test attempt 2: passed.");
	expectPacedMisses(result.requests);
}, 30_000);

test("optimization: cosmetic model metadata stays cached while a different resolved model misses once", async () => {
	const result = await reproduce("cache-model");
	expectNoFinding(result, 4);
	expect(result.requests).toHaveLength(2);
	expect(result.requests).toMatchObject([
		{ body: { model: "gemini-3.8-flash-high" } },
		{ body: { model: "gemini-3-flash-agent" } },
	]);
	expect(requestText(result.requests[0]!)).toBe(requestText(result.requests[1]!));
	expect(result.resolverCalls).toBe(2);
	expectPacedMisses(result.requests);
}, 30_000);

test("optimization: static headers and async resolver identity each miss once without resolving cache hits", async () => {
	const result = await reproduce("cache-header-config", "google");
	expectNoFinding(result, 6);
	expect(result.requests).toHaveLength(3);
	expect(result.requests.map(request => request.fixtureStaticHeader)).toEqual(["A", "B", "B"]);
	expect(result.requests.map(request => request.fixtureResolvedHeader)).toEqual(["C", "C", "C"]);
	expect(result.headerResolutionCount).toBe(3);
	expect(result.resolverCalls).toBe(3);
	expectPacedMisses(result.requests);
}, 30_000);

test("optimization: session switch, off and shutdown discard the completed cache", async () => {
	const result = await reproduce("cache-lifecycle");
	expectNoFinding(result, 4);
	expect(result.requests).toHaveLength(4);
	expect(result.requests.map(requestText)).toEqual(Array(4).fill(requestText(result.requests[0]!)));
	expect(result.notifications.filter(n => n.message.includes("nothing worth flagging")).map(n => n.sessionId)).toEqual([
		"fixture-session-a", "fixture-session-b", "fixture-session-b", "fixture-session-b",
	]);
	expectPacedMisses(result.requests);
}, 30_000);

test("optimization: a failed check is not cached but the following successful check is", async () => {
	const result = await reproduce("cache-error", "google");
	expect(result.notifications.filter(n => n.kind === "error")).toHaveLength(1);
	expect(result.notifications.filter(n => n.message.includes("nothing worth flagging"))).toHaveLength(2);
	expect(result.currentCard).toEqual([]);
	expect(result.requests).toHaveLength(2);
	expect(requestText(result.requests[0]!)).toBe(requestText(result.requests[1]!));
	expect(result.resolverCalls).toBe(2);
	expectPacedMisses(result.requests);
}, 30_000);

test("optimization: a malformed no-finding reply is not cached but the following valid reply is", async () => {
	const result = await reproduce("cache-malformed", "google");
	expectNoFinding(result, 3);
	expect(result.requests).toHaveLength(2);
	expect(requestText(result.requests[0]!)).toBe(requestText(result.requests[1]!));
	expect(result.requests.map(request => typeof request.repliedAt)).toEqual(["number", "number"]);
	expect(result.resolverCalls).toBe(2);
	expectPacedMisses(result.requests);
}, 30_000);

test("optimization: recently shown and already known topics change the cached check input", async () => {
	const result = await reproduce("cache-memory");
	expectNoFinding(result, 2);
	expect(result.cards.some(card => card.join("\n").includes("The database migration was not tested."))).toBe(true);
	expect(result.requests).toHaveLength(2);
	expect(requestText(result.requests[0]!)).not.toContain("The database migration was not tested.");
	const changed = requestText(result.requests[1]!);
	expect(changed).toContain("Already shown to them recently");
	expect(changed).toContain("They have said they already understand these");
	expect(changed.match(/The database migration was not tested\./g)).toHaveLength(2);
	expect(result.resolverCalls).toBe(2);
	expectPacedMisses(result.requests);
}, 30_000);
