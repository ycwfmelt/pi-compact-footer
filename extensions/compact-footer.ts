/**
 * Compact footer: one line combining pwd, stats, extension statuses and model.
 *
 * Built-in pi renders three lines:
 *   1. ~/path (branch) • session
 *   2. ↑in ↓out Rread CH% ctx%/window (auto)              (provider) model • thinking
 *   3. extension statuses (⚡ TTFT …)
 *
 * This extension renders a single line:
 *
 *   ~/path (branch) • session  ◎98.2% ¥0.019 2.4%/1.0M  ⚡ TTFT 0.84s · ↓41 tok/s · ~130 tok  (provider) model • thinking
 *
 * Behavior notes:
 * - `(auto)` is appended only when auto-compaction is enabled AND context
 *   usage is above AUTO_HINT_MIN_PERCENT (40%).
 * - When the terminal is too narrow, blocks are dropped in order:
 *   provider prefix → session name → statuses (truncated, then dropped) →
 *   pwd; the stats block and right-aligned model keep built-in priority.
 * - `compaction.enabled` is read from the effective settings via
 *   pi.getSettings(), so a runtime toggle is reflected immediately.
 *
 * Uses only public extension APIs: ctx.getContextUsage(),
 * ctx.sessionManager.getEntries(), ctx.model, ctx.modelRegistry, footerData.*,
 * pi.getSettings(), setFooter().
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Show "(auto)" once context usage exceeds this percentage. */
const AUTO_HINT_MIN_PERCENT = 40;
/**
 * Currency symbol for the cost readout. Pi's cost pipeline is currency-agnostic
 * (model rates are just numbers per million tokens); the deepseek/office rates
 * are CNY, so display ¥. Change to "$" if you configure USD rates.
 */
const CURRENCY = "¥";
/** Icon for the latest-request cache hit rate (replaces the old "CH" label). */
const CACHE_HIT_ICON = "◎";
/** Gap between the stats block and the merged extension statuses. */
const STATUS_GAP = "  ";
/** Minimum padding between the left block and the right-aligned model. */
const MIN_PAD = 2;
/** Below this available width, statuses are dropped instead of truncated. */
const MIN_STATUS_WIDTH = 16;

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** True when at least part of `cost` was estimated from model pricing. */
	costEstimated: boolean;
}

/** The subset of pi's Usage shape this footer reads. */
interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total?: number };
}

type ModelLike = { cost?: ModelCostRates } | undefined;

interface ModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<ModelCostRates & { inputTokensAbove: number }>;
}

function emptyUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEstimated: false };
}

/**
 * Estimate the cost of one usage record from the model's pricing table
 * (per million tokens, same math as pi's calculateCost including tiers).
 * Used when the provider reports `cost.total === 0` for custom/self-hosted
 * models, e.g. a self-hosted gateway.
 */
function estimateUsageCost(model: ModelLike, usage: UsageLike): number {
	const cost = model?.cost;
	if (!cost) return 0;
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates = cost;
	let matchedThreshold = -1;
	for (const tier of cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}
	return (
		(usage.input * rates.input +
			usage.output * rates.output +
			usage.cacheRead * rates.cacheRead +
			usage.cacheWrite * rates.cacheWrite) /
		1_000_000
	);
}

function addUsage(totals: UsageTotals, usage: UsageLike, model: ModelLike): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	const reported = usage.cost?.total ?? 0;
	if (reported > 0) {
		totals.cost += reported;
		return;
	}
	const estimated = estimateUsageCost(model, usage);
	if (estimated > 0) {
		totals.cost += estimated;
		totals.costEstimated = true;
	}
}

/** Compact token counts, mirroring the built-in footer. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Replace the home directory with ~, mirroring the built-in footer. */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Collapse control characters/newlines so a status cannot break the layout. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

interface UsageScan {
	key: string;
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
}

/**
 * Cache of the last scan. Session entries are append-only and every append moves
 * the leaf, so the result only changes with the session, the leaf, the entry
 * count, or the model whose pricing applies.
 */
let usageScan: UsageScan | undefined;

/**
 * Cumulative usage across ALL session entries, matching the built-in footer
 * (not just post-compaction messages). The footer renders on every frame, so the
 * O(entries) scan is cached on the same key the built-in footer uses.
 */
function collectUsage(ctx: ExtensionContext): UsageScan {
	const entries = ctx.sessionManager.getEntries();
	const key = [
		ctx.sessionManager.getSessionId(),
		ctx.sessionManager.getLeafId() ?? "",
		entries.length,
		ctx.model?.id ?? "",
	].join("\u0000");
	if (usageScan?.key === key) return usageScan;

	const totals = emptyUsageTotals();
	let latestCacheHitRate: number | undefined;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			addUsage(totals, usage, ctx.modelRegistry.find(entry.message.provider, entry.message.model));
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			addUsage(totals, entry.message.usage, ctx.model);
		} else if (entry.type === "usage") {
			addUsage(totals, entry.usage, ctx.model);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(totals, entry.usage, ctx.model);
		}
	}

	usageScan = { key, totals, latestCacheHitRate };
	return usageScan;
}

/**
 * Effective value of `compaction.enabled`. The settings manager already merges
 * project settings over global ones and is updated in memory by the /settings
 * toggle, so this is fresher than re-reading settings.json. It clones a small
 * object (~3us for a typical settings file), which is cheap enough to do per
 * frame.
 */
function autoCompactionEnabled(api: ExtensionAPI): boolean {
	return api.getSettings().compaction?.enabled ?? true;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			const dim = (text: string) => theme.fg("dim", text);

			function buildPwdLine(includeSession: boolean): string {
				let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;
				if (includeSession) {
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;
				}
				return pwd;
			}

			function buildStatsBlock(): string {
				const { totals, latestCacheHitRate } = collectUsage(ctx);
				const parts: string[] = [];

				// Cache hit rate of the latest request.
				if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
					parts.push(`${CACHE_HIT_ICON}${latestCacheHitRate.toFixed(1)}%`);
				}

				// Cumulative cost; "~" marks locally estimated amounts (provider
				// reports no cost and pricing comes from the model definition).
				parts.push(`${totals.costEstimated ? `~${CURRENCY}` : CURRENCY}${totals.cost.toFixed(3)}`);

				// Context usage with the conditional "(auto)" hint.
				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percentValue = contextUsage?.percent ?? 0;
				const percentUnknown = contextUsage !== undefined && contextUsage.percent === null;
				const autoHint =
					autoCompactionEnabled(pi) && !percentUnknown && percentValue > AUTO_HINT_MIN_PERCENT ? " (auto)" : "";
				const contextDisplay = percentUnknown
					? `?/${formatTokens(contextWindow)}${autoHint}`
					: `${percentValue.toFixed(1)}%/${formatTokens(contextWindow)}${autoHint}`;
				if (percentValue > 90) parts.push(theme.fg("error", contextDisplay));
				else if (percentValue > 70) parts.push(theme.fg("warning", contextDisplay));
				else parts.push(contextDisplay);

				return parts.join(" ");
			}

			function buildModelLabel(): { base: string; withProvider: string } {
				const modelName = ctx.model?.id || "no-model";
				let base = modelName;
				if (ctx.model?.reasoning) {
					const level = ctx.thinkingLevel || "off";
					base = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
				}
				const withProvider =
					footerData.getAvailableProviderCount() > 1 && ctx.model ? `(${ctx.model.provider}) ${base}` : base;
				return { base, withProvider };
			}

			function buildStatusBlock(): string {
				return Array.from(footerData.getExtensionStatuses().entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text))
					.filter((text) => text.length > 0)
					.join(STATUS_GAP);
			}

			function render(width: number): string[] {
				const stats = buildStatsBlock();
				const statuses = buildStatusBlock();
				const { base, withProvider } = buildModelLabel();
				const pwdFull = buildPwdLine(true);
				const pwdShort = buildPwdLine(false);

				/** One row: [pwd] stats [statuses] … right-aligned model, if it fits. */
				function fitLine(pwdText: string, statusText: string, rightText: string): string | undefined {
					const left = pwdText ? `${pwdText}${STATUS_GAP}${stats}` : stats;
					const statusWidth = statusText ? visibleWidth(statusText) : 0;
					const rightWidth = visibleWidth(rightText);
					const consumed = visibleWidth(left) + (statusWidth > 0 ? STATUS_GAP.length + statusWidth : 0) + rightWidth;
					if (consumed + MIN_PAD > width) return undefined;
					const middle = statusWidth > 0 ? STATUS_GAP + statusText : "";
					return dim(left) + middle + dim(" ".repeat(width - consumed) + rightText);
				}

				/** Statuses truncated to whatever fits next to pwd and model, or "" when nothing does. */
				function truncateStatuses(pwdText: string, rightText: string): string {
					const consumed =
						visibleWidth(`${pwdText}${STATUS_GAP}${stats}`) +
						STATUS_GAP.length +
						visibleWidth(rightText) +
						MIN_PAD;
					const available = width - consumed;
					return available >= MIN_STATUS_WIDTH ? truncateToWidth(statuses, available, dim("…")) : "";
				}

				// Drop blocks in priority order; the stats block and the right-aligned
				// model are given up last.
				const attempts: Array<() => string | undefined> = [
					() => fitLine(pwdFull, statuses, withProvider),
					() => fitLine(pwdFull, statuses, base),
					() => fitLine(pwdShort, statuses, base),
					() => fitLine(pwdShort, truncateStatuses(pwdShort, base), base),
					() => fitLine(pwdShort, "", base),
					() => fitLine("", "", base),
				];
				for (const attempt of attempts) {
					const line = attempt();
					if (line !== undefined) return [line];
				}

				// Very narrow terminal: stats only, then the model, then the stats themselves.
				const statsText = visibleWidth(stats) > width ? truncateToWidth(stats, width, "...") : stats;
				const statsWidth = visibleWidth(statsText);
				const rightText = statsWidth + MIN_PAD + visibleWidth(withProvider) <= width ? withProvider : base;
				const rightWidth = visibleWidth(rightText);
				if (statsWidth + MIN_PAD + rightWidth <= width) {
					return [dim(statsText) + dim(" ".repeat(width - statsWidth - rightWidth) + rightText)];
				}
				const availableForRight = width - statsWidth - MIN_PAD;
				if (availableForRight <= 0) return [dim(statsText)];
				const truncatedRight = truncateToWidth(rightText, availableForRight, "");
				const padding = " ".repeat(Math.max(0, width - statsWidth - visibleWidth(truncatedRight)));
				return [dim(statsText) + dim(padding + truncatedRight)];
			}

			return {
				render,
				invalidate() {},
				dispose() {
					unsubscribeBranch();
				},
			};
		});
	});
}
