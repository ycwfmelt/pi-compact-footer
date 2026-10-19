/**
 * Live LLM throughput in the footer (status key: "live-throughput").
 *
 * Lifecycle-aware replacement for the always-on "TTFT: waiting · Decode: waiting"
 * status. The footer now stays clean while idle:
 *
 *   idle        (nothing shown)
 *   waiting     ⚡ waiting · 2.4s                     (dim, live elapsed while
 *                                                      the first token is pending)
 *   streaming   ⚡ TTFT 0.84s · ↓41.3 tok/s · ~130 tok (accent, live estimates)
 *   done        ⚡ TTFT 0.84s · ↑1.2k tok/s · ↓41.3 tok/s · 512 tok
 *                                                      (muted, clears after LINGER_MS)
 *
 * ↑ / ↓ match the footer's input/output token convention (↑ prefill, ↓ decode).
 *
 * Uses only public extension APIs: pi.on(...), ctx.ui.setStatus(), ctx.ui.theme.
 */

import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "live-throughput";

/** Fallback chars-per-token used for live estimates before usage is known. */
const CHARS_PER_TOKEN = 4;
/** Throttle for live decode updates while tokens stream in. */
const UPDATE_INTERVAL_MS = 250;
/** Tick rate for the "waiting for first token" counter. */
const WAITING_TICK_MS = 500;
/** How long the final summary stays in the footer after the run settles. */
const LINGER_MS = 8000;
/** Minimum decode window before a tok/s estimate is meaningful. */
const MIN_DECODE_SECONDS = 0.25;

type Phase = "idle" | "waiting" | "streaming" | "done";
type StatusColor = "accent" | "dim" | "muted";

function seconds(milliseconds: number): number {
	return Math.max(0, milliseconds) / 1000;
}

/** Seconds between two timestamps, or undefined when either is missing. */
function elapsedSeconds(from: number | undefined, to: number | undefined): number | undefined {
	return from !== undefined && to !== undefined ? seconds(to - from) : undefined;
}

/** TTFT display: sub-10s keeps two decimals, longer values one. */
function formatTtft(value: number): string {
	return value >= 10 ? `${value.toFixed(1)}s` : `${value.toFixed(2)}s`;
}

/** Waiting counter display: one decimal, then minutes. */
function formatElapsed(value: number): string {
	if (value >= 60) {
		const minutes = Math.floor(value / 60);
		return `${minutes}m ${Math.floor(value % 60)}s`;
	}
	return `${value.toFixed(1)}s`;
}

function formatRate(tokensPerSecond: number): string {
	if (tokensPerSecond >= 1000) return `${(tokensPerSecond / 1000).toFixed(1)}k`;
	if (tokensPerSecond >= 100) return `${Math.round(tokensPerSecond)}`;
	return tokensPerSecond.toFixed(1);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Characters carried by one assistant stream event (0 for non-delta events). */
function deltaChars(event: MessageUpdateEvent["assistantMessageEvent"]): number {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length;
		default:
			return 0;
	}
}

/**
 * Final "done" line, built from measured timings plus the provider's usage.
 * Returns undefined when there is nothing worth showing.
 */
function buildFinalSummary(observed: {
	ttftSeconds: number | undefined;
	decodeSeconds: number | undefined;
	outputTokens: number | undefined;
	processedInputTokens: number;
	streamedChars: number;
}): string | undefined {
	const { ttftSeconds, decodeSeconds, outputTokens, processedInputTokens, streamedChars } = observed;
	const parts: string[] = [];

	if (ttftSeconds !== undefined) {
		parts.push(`TTFT ${formatTtft(ttftSeconds)}`);
	}

	// Pi normalizes usage.input to uncached input; cache writes were also
	// processed before the first token, so include them in the prefill rate.
	if (processedInputTokens > 0 && ttftSeconds !== undefined && ttftSeconds > 0) {
		parts.push(`↑${formatRate(processedInputTokens / ttftSeconds)} tok/s`);
	}

	if (outputTokens !== undefined && decodeSeconds !== undefined && decodeSeconds > 0) {
		// The first output token is the prefill's last step, not decode work.
		parts.push(`↓${formatRate(Math.max(1, outputTokens - 1) / decodeSeconds)} tok/s`);
		parts.push(`${outputTokens} tok`);
	} else if (outputTokens !== undefined) {
		parts.push(`${outputTokens} tok`);
	} else if (streamedChars > 0 && decodeSeconds !== undefined && decodeSeconds > 0) {
		const estimatedTokens = streamedChars / CHARS_PER_TOKEN;
		parts.push(`↓~${formatRate(estimatedTokens / decodeSeconds)} tok/s`);
		parts.push(`~${Math.round(estimatedTokens)} tok`);
	}

	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export default function (pi: ExtensionAPI) {
	let phase: Phase = "idle";
	let requestStartedAt: number | undefined;
	let firstOutputAt: number | undefined;
	let lastOutputAt: number | undefined;
	let streamedChars = 0;
	let lastDisplayAt = 0;
	let lastStyled: string | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;

	function clearTimers(): void {
		if (tickTimer !== undefined) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
		if (hideTimer !== undefined) {
			clearTimeout(hideTimer);
			hideTimer = undefined;
		}
	}

	function setStatus(ctx: ExtensionContext, text: string | undefined, color: StatusColor = "accent"): void {
		if (ctx.mode !== "tui") return;
		const styled = text === undefined ? undefined : ctx.ui.theme.fg(color, `⚡ ${text}`);
		// Only dedupe real updates; always forward clears so the host never keeps a stale status.
		if (styled !== undefined && styled === lastStyled) return;
		lastStyled = styled;
		ctx.ui.setStatus(STATUS_KEY, styled);
	}

	function reset(ctx: ExtensionContext): void {
		clearTimers();
		phase = "idle";
		requestStartedAt = undefined;
		firstOutputAt = undefined;
		lastOutputAt = undefined;
		streamedChars = 0;
		lastDisplayAt = 0;
		setStatus(ctx, undefined);
	}

	function renderWaiting(ctx: ExtensionContext): void {
		if (requestStartedAt === undefined) return;
		setStatus(ctx, `waiting · ${formatElapsed(seconds(Date.now() - requestStartedAt))}`, "dim");
	}

	function startWaiting(ctx: ExtensionContext): void {
		clearTimers();
		phase = "waiting";
		// Always restart the clock. When only the message_start fallback fires,
		// requestStartedAt would otherwise still hold the previous request's start
		// time and the counter would jump straight to the accumulated gap.
		requestStartedAt = Date.now();
		firstOutputAt = undefined;
		lastOutputAt = undefined;
		streamedChars = 0;
		lastDisplayAt = 0;
		renderWaiting(ctx);
		tickTimer = setInterval(() => {
			if (phase !== "waiting") return;
			renderWaiting(ctx);
		}, WAITING_TICK_MS);
	}

	function renderStreaming(ctx: ExtensionContext): void {
		if (requestStartedAt === undefined || firstOutputAt === undefined) return;
		const ttft = seconds(firstOutputAt - requestStartedAt);
		const decodeSeconds = seconds(Date.now() - firstOutputAt);
		const estimatedTokens = streamedChars / CHARS_PER_TOKEN;
		const parts = [`TTFT ${formatTtft(ttft)}`];
		if (decodeSeconds >= MIN_DECODE_SECONDS) {
			parts.push(`↓${formatRate(estimatedTokens / decodeSeconds)} tok/s`);
		}
		parts.push(`~${Math.max(1, Math.round(estimatedTokens))} tok`);
		setStatus(ctx, parts.join(" · "), "accent");
	}

	/** Show the final summary (or clear immediately when there is nothing to say). */
	function finish(ctx: ExtensionContext, text: string | undefined): void {
		clearTimers();
		if (text === undefined) {
			phase = "idle";
			setStatus(ctx, undefined);
			return;
		}
		phase = "done";
		setStatus(ctx, text, "muted");
		hideTimer = setTimeout(() => {
			hideTimer = undefined;
			if (phase === "done") {
				phase = "idle";
				setStatus(ctx, undefined);
			}
		}, LINGER_MS);
	}

	pi.on("session_start", async (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", async () => clearTimers());
	pi.on("model_select", async (_event, ctx) => reset(ctx));

	// Fires immediately before Pi sends a provider payload.
	pi.on("before_provider_request", async (_event, ctx) => {
		if (phase === "streaming") return;
		startWaiting(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		// Fallback for providers that do not emit the request hook.
		if (phase !== "streaming" && phase !== "waiting") startWaiting(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const chars = deltaChars(event.assistantMessageEvent);
		if (chars <= 0) return;

		const now = Date.now();
		if (firstOutputAt === undefined) {
			firstOutputAt = now;
			if (tickTimer !== undefined) {
				clearInterval(tickTimer);
				tickTimer = undefined;
			}
			phase = "streaming";
		}
		lastOutputAt = now;
		streamedChars += chars;

		if (now - lastDisplayAt < UPDATE_INTERVAL_MS) return;
		lastDisplayAt = now;
		renderStreaming(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (phase === "idle") return;

		const usage = event.message.usage;
		finish(
			ctx,
			buildFinalSummary({
				ttftSeconds: elapsedSeconds(requestStartedAt, firstOutputAt),
				decodeSeconds: elapsedSeconds(firstOutputAt, lastOutputAt),
				outputTokens: positiveNumber(usage?.output),
				processedInputTokens: (positiveNumber(usage?.input) ?? 0) + (positiveNumber(usage?.cacheWrite) ?? 0),
				streamedChars,
			}),
		);
	});

	// Safety net: never leave a waiting/streaming status behind once Pi settles.
	pi.on("agent_settled", async (_event, ctx) => {
		if (phase === "waiting" || phase === "streaming") finish(ctx, undefined);
	});
}
