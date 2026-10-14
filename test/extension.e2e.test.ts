import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/extension-host.mjs", import.meta.url));
interface FixtureResult {
	notifications: { message: string; kind: string; sessionId: string }[];
	cards: string[][];
	currentCard: string[];
	requests: { body: unknown; rateLimited: boolean }[];
	transportAborted: boolean[];
	paced: boolean;
}

function expectNoFinding(result: FixtureResult, completed: number) {
	expect(result.notifications.filter(n => n.kind === "error")).toEqual([]);
	expect(result.notifications.filter(n => n.message.includes("nothing worth flagging"))).toHaveLength(completed);
	expect(result.currentCard).toEqual([]);
}

async function reproduce(scenario: string, provider = "google-antigravity"): Promise<FixtureResult> {
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
		return JSON.parse(stdout);
	} finally {
		clearTimeout(deadline);
		child.kill();
		await rm(root, { recursive: true, force: true });
	}
}

for (const provider of ["google", "google-antigravity"]) {
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

for (const status of [429, 402]) {
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

for (const scenario of ["switch", "shutdown"]) {
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
