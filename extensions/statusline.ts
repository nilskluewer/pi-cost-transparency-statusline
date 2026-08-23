/**
 * Rich Status Line Extension - Pastel Edition
 *
 * Friendly pastel palette designed for dark terminal backgrounds.
 *
 * Line 1:  ~/path/to/cwd ⎇ git-branch/no-worktree ┄┄┄┄┄┄┄ ◈ model · thinking
 * Line 2:  ▲ Input  ┊  ▼ Output  ┊  ◆ Cache read  ┊  ◆ Cache write  ┊  ✦ Cache hit
 * Line 3:  Nk       ┊  Nk        ┊  Nk            ┊  Nk             ┊  XX.X%
 * Line 4:  $X.XXXX  ┊  $X.XXXX   ┊  $X.XXXX       ┊  $X.XXXX        ┊  ├━━━━━━──┤
 * Line 5:  Context N ⁄ N ├━─────────┤ XX.X%          ∑ Total $X.XXXX
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

// ── 24-bit ANSI colour helper ───────────────────────────────────────────────
const rgb =
	(r: number, g: number, b: number) =>
	(text: string): string =>
		`\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;

// ── Palette ─────────────────────────────────────────────────────────────────
const c = {
	// Navigation (line 1)
	cwd: rgb(137, 207, 240), // pastel sky blue    ~/path
	branch: rgb(255, 190, 152), // soft peach         (branch)
	model: rgb(184, 192, 255), // pastel periwinkle  model name
	thinking: rgb(255, 226, 138), // soft sunshine      (thinking level)

	// Labels - muted lavender lets the values stand out
	label: rgb(170, 166, 194),

	// Token counts (line 2)
	tokIn: rgb(168, 230, 163), // pastel green   ↑ Input
	tokOut: rgb(255, 154, 162), // pastel red     ↓ Output
	tokCacheR: rgb(255, 191, 138), // pastel orange  CacheRead
	tokCacheW: rgb(255, 191, 138), // pastel orange  CacheWrite
	cacheHit: rgb(255, 191, 138), // pastel orange  CacheHit %
	context: rgb(195, 177, 225), // soft lavender  Context tokens
	contextEmpty: rgb(69, 65, 84), // muted plum     Context bar empty
	contextText: rgb(231, 220, 255), // pale lavender  Context percentage

	// Cost breakdown (line 3)
	costIn: rgb(168, 230, 163), // pastel green   $Input
	costOut: rgb(255, 154, 162), // pastel red     $Output
	costCacheR: rgb(255, 191, 138), // pastel orange  $CacheRead
	costCacheW: rgb(255, 191, 138), // pastel orange  $CacheWrite
	costTotal: rgb(152, 228, 198), // pastel mint    Total

	// Structural
	sep: rgb(80, 76, 96), // muted plum separator
	divider: rgb(143, 137, 166), // soft lavender divider
};

const MODEL_COLUMN = 80;

// ── Extension ───────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const home = homedir();

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					requestRender = undefined;
					unsubBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					// ── Accumulate stats ─────────────────────────────────────────
					let tokIn = 0,
						tokOut = 0,
						tokCacheRead = 0,
						tokCacheWrite = 0;
					let costIn = 0,
						costOut = 0,
						costCacheRead = 0,
						costCacheWrite = 0;

					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							tokIn += m.usage.input;
							tokOut += m.usage.output;
							tokCacheRead += m.usage.cacheRead;
							tokCacheWrite += m.usage.cacheWrite;
							costIn += m.usage.cost.input;
							costOut += m.usage.cost.output;
							costCacheRead += m.usage.cost.cacheRead;
							costCacheWrite += m.usage.cost.cacheWrite;
						}
					}

					const costTotal = costIn + costOut + costCacheRead + costCacheWrite;

					// ── Formatters ───────────────────────────────────────────────
					const fmtTok = (n: number): string => {
						if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
						if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
						return `${n}`;
					};
					const fmtTokExact = (n: number): string => n.toLocaleString("en-US");
					const fmtUsd = (n: number): string => `$${n.toFixed(4)}`;

					// ── Derived stats ────────────────────────────────────────────
					const cacheWriteSupported = tokCacheWrite > 0 || (ctx.model?.cost.cacheWrite ?? 0) > 0;
					const cacheWriteDisplay = cacheWriteSupported ? fmtTok(tokCacheWrite) : "n/a";
					const cacheWriteCostDisplay = cacheWriteSupported ? fmtUsd(costCacheWrite) : "n/a";
					const totalInTokens = tokIn + tokCacheRead + tokCacheWrite;
					const cacheHitPct =
						totalInTokens > 0
							? ((tokCacheRead / totalInTokens) * 100).toFixed(1)
							: "0.0";

					const progressRail = (
						percent: number,
						fillColor: (text: string) => string,
						railWidth = 18,
					): string => {
						const pct = Math.max(0, Math.min(100, percent || 0));
						const filled = Math.round((pct / 100) * railWidth);
						return (
							c.sep("├") +
							fillColor("━".repeat(filled)) +
							c.contextEmpty("─".repeat(railWidth - filled)) +
							c.sep("┤")
						);
					};

					const ctxUsage = ctx.getContextUsage();
					const contextProgress = (tokens: number, contextWindow: number, percent: number): string => {
						const pct = Math.max(0, Math.min(100, percent || 0));
						const fillColor =
							pct >= 90
								? c.tokOut
								: pct >= 75
									? c.tokCacheW
									: pct >= 55
										? c.thinking
										: c.cwd;
						return `${c.context(fmtTokExact(tokens))}${c.label("/")}${c.context(fmtTokExact(contextWindow))} tok ${progressRail(pct, fillColor)} ${c.contextText(`${pct.toFixed(1)}%`)}`;
					};
					const ctxStr = ctxUsage
						? contextProgress(ctxUsage.tokens, ctxUsage.contextWindow, ctxUsage.percent ?? 0)
						: null;

					const thinkingLabels: Record<string, string> = {
						off: "off",
						minimal: "minimal",
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "x-high",
					};
					const thinking = thinkingLabels[pi.getThinkingLevel()] ?? pi.getThinkingLevel();

					const modelId = ctx.model?.id ?? "no model";
					const modelShort = modelId.includes("/") ? modelId.split("/").pop()! : modelId;

					// ── Helpers ──────────────────────────────────────────────────
					const SEP = c.sep("  ┊  ");

					// ── Line 1: path  (branch/worktree status)  ·····  Model: model  (thinking) ──
					const cwd = ctx.cwd.startsWith(home) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
					const branch = footerData.getGitBranch();
					const worktree = branch ? c.branch(`⎇ ${branch}`) : c.branch("⊘ no worktree");
					const left1 = c.cwd(cwd) + "  " + worktree;
					const fixedLeft1 = truncateToWidth(left1, MODEL_COLUMN - 2, "");
					const leader1 = c.sep(
						" " + "┄".repeat(Math.max(1, MODEL_COLUMN - visibleWidth(fixedLeft1) - 2)) + " ",
					);
					const model1 = c.model(`◈ ${modelShort}`) + c.label(" · ") + c.thinking(thinking);

					// Telemetry columns: header printed once, tokens and cost stacked below.
					const hitRatio = totalInTokens > 0 ? tokCacheRead / totalInTokens : 0;
					const hitGauge = progressRail(hitRatio * 100, c.cacheHit, 10);

					const columns = [
						{
							header: c.tokIn("▲ ") + c.label("Input"),
							headerWidth: visibleWidth("▲ Input"),
							tokens: c.tokIn(fmtTok(tokIn)),
							cost: c.costIn(fmtUsd(costIn)),
						},
						{
							header: c.tokOut("▼ ") + c.label("Output"),
							headerWidth: visibleWidth("▼ Output"),
							tokens: c.tokOut(fmtTok(tokOut)),
							cost: c.costOut(fmtUsd(costOut)),
						},
						{
							header: c.tokCacheR("◆ ") + c.label("Cache read"),
							headerWidth: visibleWidth("◆ Cache read"),
							tokens: c.tokCacheR(fmtTok(tokCacheRead)),
							cost: c.costCacheR(fmtUsd(costCacheRead)),
						},
						{
							header: c.tokCacheW("◆ ") + c.label("Cache write"),
							headerWidth: visibleWidth("◆ Cache write"),
							tokens: c.tokCacheW(cacheWriteDisplay),
							cost: c.costCacheW(cacheWriteCostDisplay),
						},
						{
							header: c.cacheHit("✦ ") + c.label("Cache hit"),
							headerWidth: visibleWidth("✦ Cache hit"),
							tokens: c.cacheHit(`${cacheHitPct}%`),
							cost: hitGauge,
						},
					];
					const cells = columns.map((col) => {
						const colWidth = Math.max(col.headerWidth, visibleWidth(col.tokens), visibleWidth(col.cost));
						const pad = (cell: string) => cell + " ".repeat(colWidth - visibleWidth(cell));
						return {
							header: pad(col.header),
							tokens: pad(col.tokens),
							cost: pad(col.cost),
						};
					});

					// Lines 2-4: column headers, token row, cost row.
					const line2 = cells.map((cell) => cell.header).join(SEP);
					const line3 = cells.map((cell) => cell.tokens).join(SEP);
					const line4 = cells.map((cell) => cell.cost).join(SEP);

					// ── Line 5: context gauge ····· ∑ TOTAL right-aligned ────────
					const left5 = c.label("Context ") + (ctxStr ?? c.context("n/a"));
					const total5 = c.costTotal("∑ ") + c.label("Total ") + c.costTotal(fmtUsd(costTotal));
					const gap5 = " ".repeat(Math.max(2, width - visibleWidth(left5) - visibleWidth(total5)));

					return [
						truncateToWidth(fixedLeft1 + leader1 + model1, width),
						truncateToWidth(line2, width),
						truncateToWidth(line3, width),
						truncateToWidth(line4, width),
						truncateToWidth(left5 + gap5 + total5, width),
					];
				},
			};
		});
	});

	pi.on("turn_end", async () => {
		requestRender?.();
	});
	pi.on("model_select", async () => {
		requestRender?.();
	});
	pi.on("thinking_level_select", async () => {
		requestRender?.();
	});
}
