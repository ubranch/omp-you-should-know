import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
const packageRoot = new URL("../../node_modules/@oh-my-pi/pi-coding-agent/src/", import.meta.url);
const hostEntries = [
	new URL("index.ts", packageRoot),
	new URL("extensibility/legacy-pi-coding-agent-shim.ts", packageRoot),
].map(url => fileURLToPath(url).replaceAll("\\", "/"));
const hostExports = `
	export { getAgentDir, logger } from "@oh-my-pi/pi-utils";
	export { getMarkdownTheme, initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
	export { loadExtensions } from ${JSON.stringify(fileURLToPath(new URL("extensibility/extensions/loader.ts", packageRoot)))};
`;
Bun.plugin({
	name: "ysk-fixture-host-api",
	setup(build) {
		build.onLoad({ filter: /[\\/]pi-coding-agent[\\/]src[\\/](?:index|extensibility[\\/]legacy-pi-coding-agent-shim)\.ts$/ }, args => {
			if (hostEntries.includes(args.path.replaceAll("\\", "/"))) return { contents: hostExports, loader: "ts" };
		});
	},
});
const host = await import("@oh-my-pi/pi-coding-agent");

const [scenario, provider] = process.argv.slice(2);
assert.ok(["reasoning", "pacing", "cooldown", "http-429", "http-402", "warning-reset", "first-event", "cancel-pacing", "switch", "shutdown"].includes(scenario));
assert.ok(["google", "google-antigravity"].includes(provider));
const opaqueStatus = { "http-429": 429, "http-402": 402 }[scenario];
assert.equal(host.getAgentDir(), process.env.PI_CODING_AGENT_DIR);
host.initThemeSync();

const notifications = [];
const cards = [];
const requests = [];
const transports = [];
const listeners = new Set();
const pulse = () => { for (const listener of [...listeners]) listener(); };
let currentCard = [];
let widget;
let sessionId = "fixture-session-a";
let releaseReply;
let lastReplyAt;
const blockedReply = new Promise(resolve => { releaseReply = resolve; });
const topic = "The database migration was not tested.";
const explanation = "Run the database migration test before deploying.";

async function waitFor(predicate) {
	if (!predicate()) {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners.delete(check);
				reject(new Error(`Fixture did not reach its visible result: ${JSON.stringify({ notifications, requests, cards })}`));
			}, 15_000);
			const check = () => {
				if (!predicate()) return;
				clearTimeout(timer);
				listeners.delete(check);
				resolve();
			};
			listeners.add(check);
			check();
		});
	}
	// The notification precedes the plugin's finally handler that clears inFlight.
	await setImmediate();
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		assert.equal(request.method, "POST");
		assert.equal(url.pathname, provider === "google" ? "/v1beta/models/gemini-3.8-flash:streamGenerateContent" : "/v1internal:streamGenerateContent");
		assert.equal(url.search, "?alt=sse");
		assert.equal(request.headers.get(provider === "google" ? "x-goog-api-key" : "authorization"), provider === "google" ? "fixture-key" : "Bearer fixture-token");
		const receivedAt = performance.now();
		const tooSoon = scenario === "pacing" && lastReplyAt !== undefined && receivedAt - lastReplyAt < 1_000;
		const limited = tooSoon || (scenario === "cooldown" && requests.length === 1) || (opaqueStatus !== undefined && requests.length >= 1);
		const record = { body: await request.json(), receivedAt, rateLimited: limited };
		requests.push(record);
		pulse();
		if (["switch", "shutdown"].includes(scenario) && requests.length === 1) await blockedReply;
		if (scenario === "first-event") {
			// Deliberately exceed the model's 25ms first-event watchdog, not the plugin's 90s deadline.
			await new Promise(resolve => setTimeout(resolve, 75));
		}
		if (opaqueStatus !== undefined && limited) return new Response(null, { status: opaqueStatus });
		if (scenario === "warning-reset") return new Response(null, { status: 400 });
		if (limited) {
			const error = { code: 429, status: "RESOURCE_EXHAUSTED", message: "HTTP 429 RESOURCE_EXHAUSTED: capacity exhausted" };
			return new Response(`data: ${JSON.stringify({ error })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		}
		let text = "learn: none";
		if (scenario === "reasoning") text = requests.length === 1 ? `learn: ${topic}\ntag: Heads up` : explanation;
		if (["switch", "shutdown"].includes(scenario) && requests.length === 1) text = `learn: ${topic}\ntag: Heads up`;
		const chunk = {
			candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
		};
		lastReplyAt = performance.now();
		record.repliedAt = lastReplyAt;
		return new Response(`data: ${JSON.stringify(provider === "google" ? chunk : { response: chunk })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
	},
});

const actualFetch = globalThis.fetch.bind(globalThis);
const fetches = [];
globalThis.fetch = (input, options) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.equal(url.origin, server.url.origin, "The fixture must never contact a billing provider");
	const signal = options?.signal;
	transports.push({ signal });
	const pending = actualFetch(input, options);
	fetches.push(scenario === "warning-reset" ? pending.then(response => response.clone().text()) : pending);
	return pending;
};

const bundled = getBundledModel(provider, "gemini-3.8-flash");
assert.ok(bundled, "The installed OMP catalog must contain the fixture model");
const model = {
	...bundled,
	baseUrl: `${server.url.origin}${provider === "google" ? "/v1beta" : ""}`,
	...(scenario === "first-event" ? { compat: { ...bundled.compat, streamFirstEventTimeoutMs: 25 } } : {}),
};
const boundary = (name, values) => new Proxy(values, {
	get(target, key) {
		if (key in target || typeof key === "symbol") return target[key];
		throw new Error(`Unsupported fixture host boundary: ${name}.${key}`);
	},
});
const ctx = boundary("context", {
	hasUI: true,
	mode: "tui",
	agent: { kind: "main" },
	cwd: process.cwd(),
	model,
	models: boundary("models", {
		resolve(selector) { assert.equal(selector, "@smol"); return model; },
	}),
	modelRegistry: boundary("modelRegistry", {
		resolver(selected, id) {
			assert.equal(selected, model);
			assert.equal(id, sessionId);
			return provider === "google" ? "fixture-key" : JSON.stringify({ token: "fixture-token", projectId: "fixture-project" });
		},
	}),
	sessionManager: boundary("sessionManager", {
		getSessionId: () => sessionId,
		getBranch: () => [{ type: "message", message: { role: "user", content: "Deploy the database migration.", timestamp: 1 } }],
	}),
	ui: boundary("ui", {
		notify(message, kind) { notifications.push({ message, kind, sessionId }); pulse(); },
		onTerminalInput: () => () => { },
		getEditorText: () => "",
		setWidget(key, content, options) {
			assert.equal(key, "you-should-know");
			widget?.dispose?.();
			if (content === undefined) {
				widget = undefined;
				currentCard = [];
			} else {
				assert.equal(options.placement, "aboveEditor");
				widget = content(boundary("tui", { requestRender() { } }), host.theme);
				currentCard = widget.render(120).map(line => Bun.stripANSI(line));
			}
			cards.push(currentCard);
			pulse();
		},
	}),
});

const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const loaded = await host.loadExtensions([entry], process.cwd());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert.equal(extension.label, "You should know");
const command = extension.commands.get("ysk");
assert.ok(command);
const emit = async (type, event = {}) => {
	const handlers = extension.handlers.get(type);
	assert.ok(handlers?.length, `Missing actual plugin hook ${type}`);
	for (const handler of handlers) await handler({ type, ...event }, ctx);
};
const check = async () => {
	const before = notifications.length;
	await command.handler("check", ctx);
	await waitFor(() => notifications.length >= before + 2);
};

try {
	await emit("session_start");
	if (scenario === "reasoning") {
		await emit("turn_end", { turnIndex: 5 });
		await waitFor(() => currentCard.some(line => line.includes(topic)) || notifications.some(n => n.kind === "error"));
		await command.handler("1", ctx);
		await waitFor(() => currentCard.some(line => line.includes(explanation)) || notifications.some(n => n.kind === "error"));
		assert.ok(cards.some(card => card.some(line => line.includes(topic))), "The finding must be visible before explanation");
	} else if (scenario === "pacing" || scenario === "cooldown" || opaqueStatus !== undefined) {
		await check();
		await check();
		if (scenario !== "pacing") await check();
	} else if (scenario === "warning-reset") {
		await emit("turn_end", { turnIndex: 5 });
		await waitFor(() => notifications.some(n => n.kind === "error"));
		sessionId = "fixture-session-b";
		await emit("session_switch", { reason: "new" });
		await emit("turn_end", { turnIndex: 11 });
		await waitFor(() => notifications.some(n => n.kind === "error" && n.sessionId === "fixture-session-b"));
	} else if (scenario === "cancel-pacing") {
		await check();
		await command.handler("check", ctx);
		await command.handler("off", ctx);
		await Promise.allSettled(fetches);
		await setImmediate();
		await command.handler("on", ctx);
		await check();
	} else if (scenario === "first-event") {
		await check();
	} else {
		await command.handler("check", ctx);
		await waitFor(() => requests.length === 1);
		if (scenario === "switch") sessionId = "fixture-session-b";
		await emit(scenario === "switch" ? "session_switch" : "session_shutdown", { reason: "new" });
		const aborted = transports[0].signal.aborted;
		releaseReply();
		await Promise.allSettled(fetches);
		if (!aborted) await waitFor(() => currentCard.some(line => line.includes(topic)) || notifications.some(n => n.kind === "error"));
		await setImmediate();
	}
	const result = {
		notifications,
		cards,
		currentCard,
		requests,
		transportAborted: transports.map(t => t.signal.aborted),
		paced: requests.length === 2 && requests[1].receivedAt - requests[0].receivedAt >= 4_900,
	};
	console.log(JSON.stringify(result));
} finally {
	await emit("session_shutdown");
	widget?.dispose?.();
	releaseReply();
	server.stop(true);
	globalThis.fetch = actualFetch;
}
process.exit(0);
