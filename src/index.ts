import * as fs from "node:fs";
import * as path from "node:path";
// Package roots only: omp maps those onto its own running copy. A subpath import (`pi-tui/theme`)
// resolves from the nearest node_modules instead, which is a second copy with its own classes and theme.
import { completeSimple } from "@oh-my-pi/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	logger,
} from "@oh-my-pi/pi-coding-agent";
import { Container, Markdown, matchesKey, Text, type TUI } from "@oh-my-pi/pi-tui";
import {
	type Action,
	actionFor,
	buildTranscript,
	CLEAR_AFTER_PROMPTS,
	type Depth,
	EXPLAINED_CHOICES,
	isCheckTurn,
	OFFER_CHOICES,
	parseCheckReply,
	pruneSeen,
	type SeenTopic,
	type View,
	wasSeen,
} from "./core.ts";
import { CHECK_SYSTEM, chatDraft, checkRequest, EXPLAIN_SYSTEM, explainRequest } from "./prompts.ts";

const NAME = "You should know";
const MODEL = "@smol";
const WIDGET = "you-should-know";
const DIGITS = ["0", "1", "2", "3", "4", "5"] as const;
const MAX_TRANSCRIPT_CHARS = 48_000;
const REQUEST_TIMEOUT_MS = 90_000;
// Headroom over the 25- and 160-word answers: some fast models still spend output tokens on reasoning.
const CHECK_MAX_TOKENS = 1_000;
const EXPLAIN_MAX_TOKENS = 3_000;
const STORE_FILE = path.join(getAgentDir(), "you-should-know.json");
/** OMP_YSK_DEBUG=1 also reports automatic checks that found nothing. */
const DEBUG = process.env.OMP_YSK_DEBUG === "1";

interface Store {
	enabled: boolean;
	seen: SeenTopic[];
}

function readStore(): Store {
	if (!fs.existsSync(STORE_FILE)) return { enabled: true, seen: [] };
	let raw: Partial<Store>;
	try {
		raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as Partial<Store>;
	} catch (error) {
		throw new Error(`${STORE_FILE} is not valid JSON; fix or delete it: ${String(error)}`);
	}
	return { enabled: raw.enabled !== false, seen: pruneSeen(Array.isArray(raw.seen) ? raw.seen : [], Date.now()) };
}

// ponytail: read-modify-write without a lock; two omp sessions writing in the same instant can drop one seen topic.
function updateStore(change: (store: Store) => Store): void {
	fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
	fs.writeFileSync(STORE_FILE, `${JSON.stringify(change(readStore()), null, "\t")}\n`);
}

/** The main prompt box is the only focusable component with custom key handlers; dialogs never are. */
function isPromptBox(component: unknown): boolean {
	return typeof (component as { setCustomKeyHandler?: unknown } | null)?.setCustomKeyHandler === "function";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function youShouldKnow(pi: ExtensionAPI): void {
	pi.setLabel(NAME);

	let view: View | undefined;
	let tui: TUI | undefined;
	let inFlight: AbortController | undefined;
	let unsubscribeKeys: (() => void) | undefined;
	let warnedThisSession = false;

	const active = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui" && ctx.agent.kind === "main";

	async function ask(ctx: ExtensionContext, system: string, request: string, maxTokens: number, signal: AbortSignal) {
		const model = ctx.models.resolve(MODEL);
		if (!model) throw new Error(`no model matches ${MODEL}; set modelRoles.smol in your omp config`);
		const reply = await completeSimple(
			model,
			{ systemPrompt: [system], messages: [{ role: "user", content: request, timestamp: Date.now() }] },
			{
				apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
				disableReasoning: true,
				maxTokens,
				signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
			},
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			throw new Error(`${model.provider}/${model.id}: ${reply.errorMessage ?? reply.stopReason}`);
		}
		// A reply cut at maxTokens would show a half sentence as if it were the whole point.
		if (reply.stopReason === "length") throw new Error(`${model.provider}/${model.id}: reply cut off at ${maxTokens} tokens`);
		return reply.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("")
			.trim();
	}

	function transcript(ctx: ExtensionContext): string {
		return buildTranscript(ctx.sessionManager.getBranch(), MAX_TRANSCRIPT_CHARS);
	}

	/** Logs every failure; tells the person only when they asked for it or the first time in a session. */
	function report(ctx: ExtensionContext, what: string, error: unknown, loud: boolean) {
		logger.warn(`${NAME}: ${what} failed`, { error: errorText(error) });
		if (!loud && warnedThisSession) return;
		warnedThisSession = true;
		ctx.ui.notify(`${NAME}: ${what} failed: ${errorText(error)}`, "error");
	}

	function render(ctx: ExtensionContext) {
		const current = view;
		if (!current) {
			ctx.ui.setWidget(WIDGET, undefined);
			return;
		}
		ctx.ui.setWidget(
			WIDGET,
			(ui, theme) => {
				tui = ui;
				const card = new Container();
				if (current.kind === "explained") {
					card.addChild(new Markdown(current.text, 1, 0, getMarkdownTheme()));
					card.addChild(new Text(theme.fg("dim", EXPLAINED_CHOICES), 1, 0));
				} else {
					const { tag, topic } = current.finding;
					card.addChild(new Text(`${theme.bold(theme.fg("accent", tag))} ${theme.fg("dim", "·")} ${topic}`, 1, 0));
					const choices = current.kind === "offer" ? OFFER_CHOICES : "Explaining…   0: Dismiss";
					card.addChild(new Text(theme.fg("dim", choices), 1, 0));
				}
				return card;
			},
			{ placement: "aboveEditor" },
		);
	}

	function clear(ctx: ExtensionContext) {
		inFlight?.abort();
		inFlight = undefined;
		view = undefined;
		render(ctx);
	}

	function startCheck(ctx: ExtensionContext, manual: boolean) {
		const busy = !readStore().enabled ? "it is off (/ysk on)" : inFlight ? "a check is already running" : view ? "a card is already showing" : undefined;
		if (busy) {
			if (manual) ctx.ui.notify(`${NAME}: not checking, ${busy}.`, "info");
			return;
		}
		const abort = new AbortController();
		inFlight = abort;
		if (manual) ctx.ui.notify(`${NAME}: checking the session…`, "info");
		void (async () => {
			const { seen } = readStore();
			const finding = parseCheckReply(await ask(ctx, CHECK_SYSTEM, checkRequest(transcript(ctx), seen), CHECK_MAX_TOKENS, abort.signal));
			if (abort.signal.aborted || view) return;
			if (!finding || wasSeen(seen, finding.topic)) {
				if (manual || DEBUG) ctx.ui.notify(`${NAME}: nothing worth flagging right now.`, "info");
				return;
			}
			updateStore(store => ({ ...store, seen: [...store.seen, { topic: finding.topic, at: Date.now() }] }));
			view = { kind: "offer", finding, promptsSince: 0 };
			render(ctx);
		})()
			.catch(error => {
				if (!abort.signal.aborted) report(ctx, "check", error, manual);
			})
			.finally(() => {
				if (inFlight === abort) inFlight = undefined;
			});
	}

	function explain(ctx: ExtensionContext, depth: Depth) {
		if (!view || view.kind === "explaining") return;
		const finding = view.finding;
		const previous = view.kind === "explained" ? view.text : undefined;
		const abort = new AbortController();
		inFlight = abort;
		view = { kind: "explaining", finding };
		render(ctx);
		void (async () => {
			const text = await ask(ctx, EXPLAIN_SYSTEM, explainRequest(transcript(ctx), finding, depth, previous), EXPLAIN_MAX_TOKENS, abort.signal);
			if (abort.signal.aborted) return;
			view = { kind: "explained", finding, text };
			render(ctx);
		})()
			.catch(error => {
				if (abort.signal.aborted) return;
				report(ctx, "explanation", error, true);
				view = previous ? { kind: "explained", finding, text: previous } : { kind: "offer", finding, promptsSince: 0 };
				render(ctx);
			})
			.finally(() => {
				if (inFlight === abort) inFlight = undefined;
			});
	}

	function act(action: Action, ctx: ExtensionContext) {
		if (!view) return;
		if (action === "learn") return explain(ctx, "first");
		if (action === "simpler" || action === "shorter" || action === "more") return explain(ctx, action);
		if (action === "chat") {
			if (ctx.ui.getEditorText().trim()) {
				ctx.ui.notify(`${NAME}: clear the prompt box first, then choose Chat again.`, "warning");
				return;
			}
			ctx.ui.setEditorText(chatDraft(view.finding));
		}
		clear(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		if (!active(ctx)) return;
		unsubscribeKeys?.();
		// Digits are taken only while the card is up, the main prompt box has focus and is empty,
		// and no dialog is open, so typing and approval prompts keep their keys.
		unsubscribeKeys = ctx.ui.onTerminalInput(data => {
			if (!view || !tui) return undefined;
			const digit = DIGITS.find(d => matchesKey(data, d));
			const action = digit && actionFor(view.kind, digit);
			if (!action) return undefined;
			if (!isPromptBox(tui.getFocused()) || tui.hasOverlay() || ctx.ui.getEditorText() !== "") return undefined;
			act(action, ctx);
			return { consume: true };
		});
	});

	pi.on("session_switch", (_event, ctx) => {
		if (view) clear(ctx);
	});

	pi.on("session_shutdown", () => {
		inFlight?.abort();
		unsubscribeKeys?.();
		unsubscribeKeys = undefined;
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || view?.kind !== "offer") return;
		const promptsSince = view.promptsSince + 1;
		if (promptsSince >= CLEAR_AFTER_PROMPTS) clear(ctx);
		else view = { ...view, promptsSince };
	});

	pi.on("turn_end", (event, ctx) => {
		// Never awaited: turn_end handlers block the agent loop.
		if (active(ctx) && isCheckTurn(event.turnIndex)) startCheck(ctx, false);
	});

	pi.registerCommand("ysk", {
		description: "You should know: check now, on, off, or press a card choice (1 2 3 4 5 0)",
		handler: async (args, ctx) => {
			if (!active(ctx)) {
				ctx.ui.notify(`${NAME} needs the interactive omp TUI.`, "warning");
				return;
			}
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				updateStore(store => ({ ...store, enabled: arg === "on" }));
				if (arg === "off" && (view || inFlight)) clear(ctx);
				ctx.ui.notify(`${NAME} is ${arg}.`, "info");
				return;
			}
			if (arg === "check") return startCheck(ctx, true);
			if (arg === "") {
				const model = ctx.models.resolve(MODEL);
				const state = readStore().enabled ? "on" : "off";
				ctx.ui.notify(
					`${NAME} is ${state}; side model ${model ? `${model.provider}/${model.id}` : `missing (${MODEL})`}; card: ${view?.kind ?? "none"}. Try /ysk check.`,
					"info",
				);
				return;
			}
			const action = view && actionFor(view.kind, arg);
			if (!action) {
				ctx.ui.notify(`${NAME}: "${arg}" is not a choice on the current card.`, "warning");
				return;
			}
			act(action, ctx);
		},
	});
}
