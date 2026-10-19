/**
 * Smoke tests for both extensions.
 *
 * These do not talk to a model: they drive the extension entry points with
 * stubs and assert the observable output — the footer line for a range of
 * terminal widths, and the status text through a full request lifecycle.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import compactFooter from "../extensions/compact-footer";
import liveThroughput from "../extensions/live-throughput-status";

type Handler = (event: unknown, ctx: unknown) => unknown;

// ---------------------------------------------------------------- footer stubs

interface FooterHarness {
	/** Render the footer at the given terminal width. */
	render(width: number): string;
	/** Every `theme.fg(color, text)` call, in order. */
	colorCalls: Array<{ color: string; text: string }>;
	/** Replace the extension statuses reported by the footer data provider. */
	setStatuses(entries: Array<[string, string]>): void;
	/** Replace the reported context usage. */
	setContextUsage(usage: { percent: number | null; contextWindow: number } | undefined): void;
	/** Replace the settings returned by `pi.getSettings()`. */
	setSettings(settings: { compaction?: { enabled?: boolean } }): void;
}

const BRANCH = "main";
const SESSION_NAME = "refactor-footer";
// Under the real home directory so the `~` abbreviation is exercised.
const CWD = join(homedir(), "project", "angelina");
const CWD_DISPLAY = "~/project/angelina";
const MODEL = {
	id: "claude-sonnet-4",
	provider: "anthropic",
	reasoning: true,
	contextWindow: 200_000,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function assistantEntry(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: number;
}) {
	return {
		type: "message",
		message: {
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cost: usage.cost === undefined ? undefined : { total: usage.cost },
			},
		},
	};
}

/** Build the footer once and expose its render output plus the stubs it uses. */
function makeFooterHarness(options?: {
	entries?: unknown[];
	statuses?: Array<[string, string]>;
	contextUsage?: { percent: number | null; contextWindow: number };
	settings?: { compaction?: { enabled?: boolean } };
	providerCount?: number;
}): FooterHarness {
	let entries = options?.entries ?? [];
	let statuses = new Map(options?.statuses ?? []);
	let contextUsage = options?.contextUsage;
	let settings = options?.settings ?? { compaction: { enabled: true } };
	const colorCalls: Array<{ color: string; text: string }> = [];

	const theme = {
		fg(color: string, text: string) {
			colorCalls.push({ color, text });
			return text;
		},
	};
	const footerData = {
		getGitBranch: () => BRANCH,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => options?.providerCount ?? 1,
		onBranchChange: () => () => {},
	};
	const ctx = {
		mode: "tui",
		cwd: CWD,
		model: MODEL,
		thinkingLevel: "high",
		modelRegistry: { find: () => MODEL },
		getContextUsage: () => contextUsage,
		sessionManager: {
			getCwd: () => CWD,
			getSessionId: () => "session-1",
			getLeafId: () => "leaf-1",
			getEntries: () => entries,
			getSessionName: () => SESSION_NAME,
		},
		ui: { setFooter: (factory: unknown) => (captured = factory) },
	};

	let captured: unknown;
	let handler: Handler | undefined;
	const pi = {
		on: (name: string, fn: Handler) => {
			if (name === "session_start") handler = fn;
		},
		getSettings: () => settings,
	};
	compactFooter(pi as never);
	handler?.({ type: "session_start" }, ctx);

	const footer = (captured as (t: unknown, th: unknown, fd: unknown) => { render(w: number): string[] })(
		{ requestRender: () => {} },
		theme,
		footerData,
	);

	return {
		render: (width: number) => {
			const lines = footer.render(width);
			expect(lines).toHaveLength(1);
			return lines[0] ?? "";
		},
		colorCalls,
		setStatuses: (next) => {
			statuses = new Map(next);
		},
		setContextUsage: (next) => {
			contextUsage = next;
		},
		setSettings: (next) => {
			settings = next;
		},
	};
}

// ------------------------------------------------------------- footer behavior

describe("compact-footer", () => {
	test("宽终端下把四块内容合并成一行", () => {
		const h = makeFooterHarness({ entries: [assistantEntry({ input: 1000, output: 200, cacheRead: 9000, cacheWrite: 0, cost: 0.019 })] });
		const line = h.render(200);

		expect(line).toContain(`${CWD_DISPLAY} (main) • refactor-footer`);
		expect(line).toContain("◎90.0%");
		expect(line).toContain("¥0.019");
		expect(line).toContain("claude-sonnet-4 • high");
	});

	test("单行宽度不超过终端宽度", () => {
		const h = makeFooterHarness({
			entries: [assistantEntry({ input: 1000, output: 200, cacheRead: 9000, cacheWrite: 0, cost: 0.019 })],
			statuses: [["live-throughput", "⚡ TTFT 0.84s · ↓41 tok/s · ~130 tok"]],
		});
		for (let width = 20; width <= 220; width += 1) {
			expect(visibleWidth(h.render(width))).toBeLessThanOrEqual(width);
		}
	});

	test("窄终端按优先级依次丢弃状态、会话名和 pwd", () => {
		const h = makeFooterHarness({
			entries: [assistantEntry({ input: 1000, output: 200, cacheRead: 9000, cacheWrite: 0, cost: 0.019 })],
			statuses: [["live-throughput", "⚡ TTFT 0.84s · ↓41 tok/s · ~130 tok"]],
		});

		const wide = h.render(200);
		expect(wide).toContain("refactor-footer");
		expect(wide).toContain("TTFT");

		// Session name is the first thing to go when the provider prefix no longer fits.
		const narrower = h.render(120);
		expect(narrower).toContain(`${CWD_DISPLAY} (main)`);

		// Very narrow: the stats block and the model survive.
		const tiny = h.render(40);
		expect(tiny).toContain("¥0.019");
		expect(tiny).toContain("claude-sonnet-4");
	});

	test("provider 前缀只在多 provider 时出现", () => {
		const single = makeFooterHarness({ providerCount: 1 });
		expect(single.render(200)).not.toContain("(anthropic)");

		const multi = makeFooterHarness({ providerCount: 2 });
		expect(multi.render(200)).toContain("(anthropic) claude-sonnet-4 • high");
	});

	test("上下文占用超阈值时提示 auto 并变色", () => {
		const h = makeFooterHarness({ contextUsage: { percent: 72.5, contextWindow: 200_000 } });
		expect(h.render(200)).toContain("72.5%/200k (auto)");
		expect(h.colorCalls.some((call) => call.color === "warning" && call.text.startsWith("72.5%"))).toBe(true);
	});

	test("关闭自动压缩后不再显示 auto", () => {
		const h = makeFooterHarness({ contextUsage: { percent: 72.5, contextWindow: 200_000 } });
		expect(h.render(200)).toContain("(auto)");

		h.setSettings({ compaction: { enabled: false } });
		expect(h.render(200)).not.toContain("(auto)");
	});

	test("上下文占用低于阈值时不显示 auto", () => {
		const h = makeFooterHarness({ contextUsage: { percent: 12, contextWindow: 200_000 } });
		expect(h.render(200)).toContain("12.0%/200k");
		expect(h.render(200)).not.toContain("(auto)");
	});

	test("provider 未报告成本时按模型价目表估算并加 ~ 前缀", () => {
		const h = makeFooterHarness({ entries: [assistantEntry({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })] });
		// 1M input tokens at $3/M.
		expect(h.render(200)).toContain("~¥3.000");
	});

	test("扩展状态按 key 排序并保留其他扩展的内容", () => {
		const h = makeFooterHarness({
			statuses: [
				["zeta", "zeta-status"],
				["alpha", "alpha-status"],
			],
		});
		const line = h.render(200);
		expect(line.indexOf("alpha-status")).toBeLessThan(line.indexOf("zeta-status"));
	});

	test("状态里的换行会被压平，避免撑破单行布局", () => {
		const h = makeFooterHarness({ statuses: [["noisy", "line one\nline two\t\tend"]] });
		const line = h.render(200);
		expect(line).toContain("line one line two end");
	});
});

// ---------------------------------------------------- live throughput lifecycle

interface ThroughputHarness {
	emit(name: string, event: unknown): void;
	statuses: Array<string | undefined>;
	/** The last status text with the `⚡ ` prefix removed, or undefined when cleared. */
	last(): string | undefined;
}

function makeThroughputHarness(): ThroughputHarness {
	const handlers = new Map<string, Handler>();
	const statuses: Array<string | undefined> = [];
	const theme = { fg: (_color: string, text: string) => text };
	const ctx = {
		mode: "tui",
		ui: {
			theme,
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};
	liveThroughput({
		on: (name: string, fn: Handler) => handlers.set(name, fn),
	} as never);

	return {
		emit: (name, event) => {
			const fn = handlers.get(name);
			if (!fn) throw new Error(`no handler registered for ${name}`);
			fn(event, ctx);
		},
		statuses,
		last: () => {
			const value = statuses[statuses.length - 1];
			return value === undefined ? undefined : value.replace(/^⚡ /, "");
		},
	};
}

const assistantMessage = (usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({
	role: "assistant",
	usage,
});

/** Let real wall-clock time pass so TTFT/decode measurements are non-zero. */
function tick(milliseconds = 5): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("live-throughput-status", () => {
	test("空闲时不显示任何状态", () => {
		const h = makeThroughputHarness();
		expect(h.last()).toBeUndefined();
	});

	test("等待首 token 时显示计时，首 token 到达后切换为吞吐量", () => {
		const h = makeThroughputHarness();
		h.emit("before_provider_request", { type: "before_provider_request" });
		expect(h.last()).toMatch(/^waiting · \d+\.\ds$/);

		h.emit("message_start", { type: "message_start", message: assistantMessage() });
		h.emit("message_update", {
			type: "message_update",
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "hello world" },
		});
		expect(h.last()).toContain("TTFT");
		expect(h.last()).toContain("tok");
	});

	test("非 delta 事件不启动计时", () => {
		const h = makeThroughputHarness();
		h.emit("before_provider_request", { type: "before_provider_request" });
		const waiting = h.last();

		h.emit("message_update", {
			type: "message_update",
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		expect(h.last()).toBe(waiting);
	});

	test("请求结束后用真实 usage 汇总吞吐量", async () => {
		const h = makeThroughputHarness();
		h.emit("before_provider_request", { type: "before_provider_request" });
		await tick();
		h.emit("message_start", { type: "message_start", message: assistantMessage() });
		h.emit("message_update", {
			type: "message_update",
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "some streamed text" },
		});
		await tick();
		// A second delta gives the decode window a non-zero duration; a single
		// event would leave the decode rate undefined and be omitted.
		h.emit("message_update", {
			type: "message_update",
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: " and more" },
		});
		h.emit("message_end", {
			type: "message_end",
			message: assistantMessage({ input: 1200, output: 512, cacheRead: 0, cacheWrite: 0 }),
		});

		const summary = h.last();
		expect(summary).toContain("TTFT");
		expect(summary).toContain("512 tok");
		expect(summary).toContain("↑");
		expect(summary).toContain("↓");
	});

	test("单个 delta 事件没有解码窗口时省略解码速率", () => {
		const h = makeThroughputHarness();
		h.emit("before_provider_request", { type: "before_provider_request" });
		h.emit("message_start", { type: "message_start", message: assistantMessage() });
		h.emit("message_update", {
			type: "message_update",
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "one chunk" },
		});
		h.emit("message_end", {
			type: "message_end",
			message: assistantMessage({ input: 10, output: 42, cacheRead: 0, cacheWrite: 0 }),
		});

		expect(h.last()).toContain("42 tok");
		expect(h.last()).not.toContain("↓");
	});

	test("agent_settled 兜底清除残留的 waiting 状态", () => {
		const h = makeThroughputHarness();
		h.emit("before_provider_request", { type: "before_provider_request" });
		expect(h.last()).toMatch(/^waiting/);

		h.emit("agent_settled", { type: "agent_settled" });
		expect(h.last()).toBeUndefined();
	});

	test("非 assistant 消息被忽略", () => {
		const h = makeThroughputHarness();
		h.emit("message_start", { type: "message_start", message: { role: "user" } });
		h.emit("message_update", {
			type: "message_update",
			message: { role: "user" },
			assistantMessageEvent: { type: "text_delta", delta: "hi" },
		});
		expect(h.last()).toBeUndefined();
	});
});
