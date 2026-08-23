/**
 * Cost transparency statusline for Pi.
 *
 * The footer stays deliberately local: token and cost values come from Pi's session entries,
 * while optional subscription quota values are refreshed through provider-native integrations.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
	createDefaultConfig,
	describeConfig,
	isSegmentEnabled,
	listSegments,
	loadConfig,
	normalizeConfig,
	saveConfig,
	setSegment,
	type SegmentId,
	type StatuslineConfig,
} from "./config.ts";
import {
	fetchCodexQuota,
	formatQuota,
	parseAnthropicQuotaHeaders,
	quotaRemaining,
	type QuotaSnapshot,
} from "./quota.ts";

// ── 24-bit ANSI colour helper ───────────────────────────────────────────────
const rgb =
	(r: number, g: number, b: number) =>
	(text: string): string =>
		`\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;

// ── Palette ─────────────────────────────────────────────────────────────────
const c = {
	// Navigation (line 1)
	cwd: rgb(137, 207, 240),
	branch: rgb(255, 190, 152),
	worktree: rgb(255, 211, 145),
	model: rgb(184, 192, 255),
	thinking: rgb(255, 226, 138),
	runState: rgb(152, 228, 198),

	// Labels - muted lavender lets the values stand out
	label: rgb(170, 166, 194),

	// Token counts
	tokIn: rgb(168, 230, 163),
	tokOut: rgb(255, 154, 162),
	tokCacheR: rgb(255, 191, 138),
	tokCacheW: rgb(255, 191, 138),
	cacheHit: rgb(255, 191, 138),
	context: rgb(195, 177, 225),
	contextEmpty: rgb(69, 65, 84),
	contextText: rgb(231, 220, 255),

	// Cost breakdown
	costIn: rgb(168, 230, 163),
	costOut: rgb(255, 154, 162),
	costCacheR: rgb(255, 191, 138),
	costCacheW: rgb(255, 191, 138),
	costTotal: rgb(152, 228, 198),

	// Runtime integrations
	task: rgb(137, 207, 240),
	quota: rgb(152, 228, 198),

	// Structural
	sep: rgb(80, 76, 96),
};

const MODEL_COLUMN = 96;
const STATUSLINE_STATUS_KEY = "pi-cost-transparency-statusline";

type RunState = "Ready" | "Thinking" | "Working";

interface Totals {
	tokIn: number;
	tokOut: number;
	tokCacheRead: number;
	tokCacheWrite: number;
	costIn: number;
	costOut: number;
	costCacheRead: number;
	costCacheWrite: number;
}

function getGitWorktreeName(cwd: string): string | undefined {
	try {
		const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim().replaceAll("\\", "/");
		if (!gitDir.includes("/.git/worktrees/") && !gitDir.startsWith(".git/worktrees/")) return undefined;

		const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return root ? basename(root) : undefined;
	} catch {
		return undefined;
	}
}

function isUsingOAuth(ctx: ExtensionContext): boolean {
	if (!ctx.model) return false;
	try {
		return ctx.modelRegistry.isUsingOAuth(ctx.model);
	} catch {
		return false;
	}
}

function isCodexSubscription(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" && isUsingOAuth(ctx);
}

function isAnthropicSubscription(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "anthropic" && isUsingOAuth(ctx);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

function formatExactTokenCount(n: number): string {
	return n.toLocaleString("en-US");
}

function formatUsd(n: number): string {
	return `$${n.toFixed(4)}`;
}

function collectTotals(ctx: ExtensionContext): Totals {
	const totals: Totals = {
		tokIn: 0,
		tokOut: 0,
		tokCacheRead: 0,
		tokCacheWrite: 0,
		costIn: 0,
		costOut: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
	};

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		totals.tokIn += message.usage.input;
		totals.tokOut += message.usage.output;
		totals.tokCacheRead += message.usage.cacheRead;
		totals.tokCacheWrite += message.usage.cacheWrite;
		totals.costIn += message.usage.cost.input;
		totals.costOut += message.usage.cost.output;
		totals.costCacheRead += message.usage.cost.cacheRead;
		totals.costCacheWrite += message.usage.cost.cacheWrite;
	}

	return totals;
}

function statusText(footerData: ReadonlyFooterDataProvider): string | undefined {
	const statuses = [...footerData.getExtensionStatuses()]
		.filter(([key, value]) => key !== STATUSLINE_STATUS_KEY && value.trim().length > 0)
		.map(([key, value]) => `${key}: ${value}`);
	return statuses.length > 0 ? statuses.join("  ┊  ") : undefined;
}

function statuslineSegment(config: StatuslineConfig, id: SegmentId): boolean {
	return isSegmentEnabled(config, id);
}

function saveSegmentConfig(config: StatuslineConfig, id: SegmentId, enabled: boolean): StatuslineConfig {
	const next = setSegment(config, id, enabled);
	saveConfig(next);
	return next;
}

async function openStatuslineSelector(
	ctx: ExtensionContext,
	getConfig: () => StatuslineConfig,
	setConfig: (config: StatuslineConfig) => void,
	refresh: () => void,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/statusline requires TUI mode", "error");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const title = new Text(
			theme.fg("accent", theme.bold("Configure Status Line")) +
				"\n" +
				theme.fg("muted", "Select which items to display in the status line."),
			1,
			1,
		);
		const segmentIds = new Set(listSegments().map((segment) => segment.id));
		const settingsTheme = getSettingsListTheme();
		const checkboxTheme = {
			...settingsTheme,
			value: (value: string, selected: boolean) =>
				settingsTheme.value(value === "enabled" ? "[x]" : value === "disabled" ? "[]" : value, selected),
		};
		const items: SettingItem[] = [
			...listSegments().map((segment) => ({
				id: segment.id,
				label: segment.label,
				description: segment.description,
				currentValue: statuslineSegment(getConfig(), segment.id) ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
			})),
			{
				id: "reset",
				label: "Reset defaults",
				description: "Restore the default item set",
				currentValue: "reset",
				values: ["reset"],
			},
		];

		let settingsList: SettingsList;
		const container = new Container();
		container.addChild(title);
		settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			checkboxTheme,
			(id, newValue) => {
				try {
					if (id === "reset") {
						const next = createDefaultConfig();
						saveConfig(next);
						setConfig(next);
						for (const segment of listSegments()) {
							settingsList.updateValue(
								segment.id,
								statuslineSegment(next, segment.id) ? "enabled" : "disabled",
							);
						}
					} else if (segmentIds.has(id as SegmentId)) {
						const next = saveSegmentConfig(getConfig(), id as SegmentId, newValue === "enabled");
						setConfig(next);
					}
					refresh();
					tui.requestRender();
				} catch (error) {
					ctx.ui.notify(`Could not save statusline settings: ${formatError(error)}`, "error");
				}
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(settingsList);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let quotaSnapshot: QuotaSnapshot | undefined;
	let requestRender: (() => void) | undefined;
	let quotaTimer: ReturnType<typeof setInterval> | undefined;
	let sessionGeneration = 0;
	let runState: RunState = "Ready";
	let worktreeName: string | undefined;

	const refresh = () => requestRender?.();

	const clearQuotaTimer = () => {
		if (quotaTimer) clearInterval(quotaTimer);
		quotaTimer = undefined;
	};

	const refreshCodexQuota = async (ctx: ExtensionContext, generation: number) => {
		if (ctx.mode !== "tui" || !isCodexSubscription(ctx) || generation !== sessionGeneration) return;
		const next = await fetchCodexQuota();
		if (generation !== sessionGeneration) return;
		quotaSnapshot = next;
		refresh();
	};

	const startQuotaRefresh = (ctx: ExtensionContext) => {
		clearQuotaTimer();
		quotaSnapshot = undefined;
		const generation = sessionGeneration;
		if (ctx.mode !== "tui" || !isCodexSubscription(ctx)) {
			refresh();
			return;
		}
		void refreshCodexQuota(ctx, generation);
		quotaTimer = setInterval(() => void refreshCodexQuota(ctx, generation), config.quotaRefreshIntervalMs);
		quotaTimer.unref?.();
	};

	const applyConfig = (next: StatuslineConfig, ctx?: ExtensionContext) => {
		config = normalizeConfig(next);
		if (ctx) startQuotaRefresh(ctx);
		refresh();
	};

	const setSegmentFromCommand = (ctx: ExtensionContext, name: string | undefined, enabled: boolean) => {
		if (!name || !listSegments().some((segment) => segment.id === name)) {
			ctx.ui.notify(`Unknown segment "${name ?? ""}". Run /statusline list to see all segments.`, "warning");
			return;
		}
		try {
			const next = saveSegmentConfig(config, name as SegmentId, enabled);
			applyConfig(next, ctx);
			ctx.ui.notify(`Segment "${name}" turned ${enabled ? "on" : "off"}.`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not save statusline settings: ${formatError(error)}`, "error");
		}
	};

	const resetConfig = (ctx: ExtensionContext) => {
		try {
			const next = createDefaultConfig();
			saveConfig(next);
			applyConfig(next, ctx);
			ctx.ui.notify("Statusline settings reset to defaults.", "info");
		} catch (error) {
			ctx.ui.notify(`Could not save statusline settings: ${formatError(error)}`, "error");
		}
	};

	const statuslineCommand = {
		description: "Configure statusline items: list, add/on, remove/off, reset",
		handler: async (args: string, ctx: ExtensionContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const command = tokens[0]?.toLowerCase();
			const name = tokens[1];

			if (!command) {
				await openStatuslineSelector(ctx, () => config, (next) => applyConfig(next, ctx), refresh);
				return;
			}
			if (command === "list") {
				ctx.ui.notify(describeConfig(config), "info");
				return;
			}
			if (command === "reset") {
				resetConfig(ctx);
				return;
			}
			if (["on", "add"].includes(command)) {
				setSegmentFromCommand(ctx, name, true);
				return;
			}
			if (["off", "remove", "rm"].includes(command)) {
				setSegmentFromCommand(ctx, name, false);
				return;
			}
			ctx.ui.notify("Usage: /statusline [list|reset|on|off|add|remove] [segment]", "warning");
		},
		getArgumentCompletions: (argumentPrefix: string) => {
			const tokens = argumentPrefix.split(/\s+/);
			if (tokens.length <= 1) {
				const prefix = tokens[0] ?? "";
				return ["list", "reset", "on", "off", "add", "remove"]
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({ value, label: value }));
			}
			if (!["on", "off", "add", "remove", "rm"].includes(tokens[0] ?? "")) return null;
			const prefix = tokens.at(-1) ?? "";
			return listSegments()
				.filter((segment) => segment.id.startsWith(prefix))
				.map((segment) => ({ value: segment.id, label: segment.label, description: segment.description }));
		},
	};
	pi.registerCommand("statusline", statuslineCommand);

	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration++;
		config = loadConfig();
		runState = "Ready";
		worktreeName = getGitWorktreeName(ctx.cwd);

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
					const totals = collectTotals(ctx);
					const enabled = (id: SegmentId) => statuslineSegment(config, id);
					const costTotal = totals.costIn + totals.costOut + totals.costCacheRead + totals.costCacheWrite;
					const cacheWriteSupported = totals.tokCacheWrite > 0 || (ctx.model?.cost.cacheWrite ?? 0) > 0;
					const totalInTokens = totals.tokIn + totals.tokCacheRead + totals.tokCacheWrite;
					const cacheHitPct = totalInTokens > 0 ? ((totals.tokCacheRead / totalInTokens) * 100).toFixed(1) : "0.0";

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
					const contextText = ctxUsage
						? `${c.context(formatExactTokenCount(ctxUsage.tokens ?? 0))}${c.label("/")}${c.context(formatExactTokenCount(ctxUsage.contextWindow))} tok ${progressRail(ctxUsage.percent ?? 0, c.cwd)} ${c.contextText(`${(ctxUsage.percent ?? 0).toFixed(1)}%`)}`
						: c.context("n/a");

					const thinkingLabels: Record<string, string> = {
						off: "off",
						minimal: "minimal",
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "x-high",
						max: "max",
					};
					const thinking = thinkingLabels[pi.getThinkingLevel()] ?? pi.getThinkingLevel();
					const modelId = ctx.model?.id ?? "no model";
					const modelShort = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
					const home = homedir();
					const cwd = ctx.cwd.startsWith(home) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
					const branch = footerData.getGitBranch();

					const cwdPart = enabled("cwd") ? c.cwd(cwd) : "";
					const identityParts: string[] = [];
					if (enabled("git-branch") && branch) identityParts.push(c.branch(`⎇ ${branch}`));
					if (enabled("git-worktree")) {
						identityParts.push(c.worktree(worktreeName ? `⌂ worktree:${worktreeName}` : "⌂ no worktree"));
					}
					const identity = identityParts.join("  ");
					const leftWidth = MODEL_COLUMN - 2;
					const cwdSeparator = cwdPart && identity ? "  " : "";
					const cwdWidth = Math.max(1, leftWidth - visibleWidth(identity) - visibleWidth(cwdSeparator));
					const fixedCwd = cwdPart ? truncateToWidth(cwdPart, cwdWidth, "") : "";
					const left1 = fixedCwd + cwdSeparator + identity;

					const rightParts: string[] = [];
					if (enabled("model")) rightParts.push(c.model(`◈ ${modelShort}`));
					if (enabled("thinking")) rightParts.push(c.label(" · ") + c.thinking(thinking));
					if (enabled("run-state")) {
						const stateColor = runState === "Working" ? c.tokCacheW : runState === "Thinking" ? c.thinking : c.runState;
						rightParts.push(c.label(" · ") + stateColor(runState));
					}
					const right1 = rightParts.join("");

					let line1 = "";
					if (left1 && right1) {
						const fixedLeft1 = truncateToWidth(left1, MODEL_COLUMN - 2, "");
						const leader1 = c.sep(
							" " + "┄".repeat(Math.max(1, MODEL_COLUMN - visibleWidth(fixedLeft1) - 2)) + " ",
						);
						line1 = fixedLeft1 + leader1 + right1;
					} else {
						line1 = left1 || right1;
					}

					const SEP = c.sep("  ┊  ");
					const columns: Array<{
						header: string;
						tokens: string;
						cost: string;
					}> = [];
					if (enabled("input")) columns.push({ header: c.tokIn("▲ ") + c.label("Input"), tokens: c.tokIn(formatTokenCount(totals.tokIn)), cost: c.costIn(formatUsd(totals.costIn)) });
					if (enabled("output")) columns.push({ header: c.tokOut("▼ ") + c.label("Output"), tokens: c.tokOut(formatTokenCount(totals.tokOut)), cost: c.costOut(formatUsd(totals.costOut)) });
					if (enabled("cache-read")) columns.push({ header: c.tokCacheR("◆ ") + c.label("Cache read"), tokens: c.tokCacheR(formatTokenCount(totals.tokCacheRead)), cost: c.costCacheR(formatUsd(totals.costCacheRead)) });
					if (enabled("cache-write")) columns.push({ header: c.tokCacheW("◆ ") + c.label("Cache write"), tokens: c.tokCacheW(cacheWriteSupported ? formatTokenCount(totals.tokCacheWrite) : "n/a"), cost: c.costCacheW(cacheWriteSupported ? formatUsd(totals.costCacheWrite) : "n/a") });
					if (enabled("cache-hit")) columns.push({ header: c.cacheHit("✦ ") + c.label("Cache hit"), tokens: c.cacheHit(`${cacheHitPct}%`), cost: progressRail(totalInTokens > 0 ? (totals.tokCacheRead / totalInTokens) * 100 : 0, c.cacheHit, 10) });

					const cells = columns.map((column) => {
						const columnWidth = Math.max(visibleWidth(column.header), visibleWidth(column.tokens), visibleWidth(column.cost));
						const pad = (value: string) => value + " ".repeat(columnWidth - visibleWidth(value));
						return { header: pad(column.header), tokens: pad(column.tokens), cost: pad(column.cost) };
					});
					const columnLines = cells.length > 0
						? [
								cells.map((cell) => cell.header).join(SEP),
								cells.map((cell) => cell.tokens).join(SEP),
								cells.map((cell) => cell.cost).join(SEP),
							]
						: [];

					const totalText = enabled("session-cost")
						? c.costTotal("∑ ") + c.label("Total ") + c.costTotal(formatUsd(costTotal))
						: "";
					const contextLine = enabled("context") ? c.label("Context ") + contextText : "";
					const line5 = contextLine || totalText
						? contextLine && totalText
							? contextLine + " ".repeat(Math.max(2, width - visibleWidth(contextLine) - visibleWidth(totalText))) + totalText
							: contextLine + totalText
						: "";

					const extraLines: string[] = [];
					if (enabled("task-progress")) {
						const progress = statusText(footerData);
						if (progress) extraLines.push(truncateToWidth(c.task("Task ") + progress, width));
					}
					if (enabled("subscription-quota") && quotaSnapshot) {
						const activeProvider = ctx.model?.provider;
						const matches = (quotaSnapshot.provider === "codex" && activeProvider === "openai-codex") ||
							(quotaSnapshot.provider === "anthropic" && activeProvider === "anthropic");
						if (matches) {
							const minimumRemaining = Math.min(...quotaSnapshot.windows.map(quotaRemaining));
							const color = minimumRemaining <= 10 ? c.tokOut : minimumRemaining <= 25 ? c.thinking : c.quota;
							extraLines.push(truncateToWidth(color(`Quota ${formatQuota(quotaSnapshot)}`), width));
						}
					}

					return [line1, ...columnLines, line5, ...extraLines]
						.filter((line) => line.length > 0)
						.map((line) => truncateToWidth(line, width, ""));
				},
			};
		});

		startQuotaRefresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionGeneration++;
		clearQuotaTimer();
		quotaSnapshot = undefined;
		try {
			ctx.ui.setFooter(undefined);
		} catch {
			// The footer may already be disposed during a reload.
		}
	});

	pi.on("agent_start", () => {
		runState = "Thinking";
		refresh();
	});
	pi.on("turn_start", () => {
		runState = "Thinking";
		refresh();
	});
	pi.on("tool_execution_start", () => {
		runState = "Working";
		refresh();
	});
	pi.on("tool_execution_end", () => {
		runState = "Thinking";
		refresh();
	});
	pi.on("agent_end", () => {
		runState = "Ready";
		refresh();
	});
	pi.on("turn_end", async (_event, ctx) => {
		refresh();
		if (isCodexSubscription(ctx)) void refreshCodexQuota(ctx, sessionGeneration);
	});
	pi.on("model_select", async (_event, ctx) => {
		startQuotaRefresh(ctx);
		refresh();
	});
	pi.on("thinking_level_select", () => refresh());
	pi.on("after_provider_response", async (event, ctx) => {
		if (ctx.mode !== "tui" || !isAnthropicSubscription(ctx)) return;
		const next = parseAnthropicQuotaHeaders(event.headers);
		if (next) {
			quotaSnapshot = next;
			refresh();
		}
	});
}
