import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SegmentId =
	| "cwd"
	| "git-branch"
	| "git-worktree"
	| "model"
	| "thinking"
	| "run-state"
	| "input"
	| "output"
	| "cache-read"
	| "cache-write"
	| "cache-hit"
	| "context"
	| "session-cost"
	| "task-progress"
	| "subscription-quota";

export interface SegmentDefinition {
	id: SegmentId;
	label: string;
	description: string;
}

export type ThemeId =
	| "pastel-sci-fi"
	| "green-screen"
	| "amber-crt"
	| "monokai"
	| "solarized-dark"
	| "dracula"
	| "gruvbox"
	| "nord"
	| "tokyo-night"
	| "catppuccin-mocha";

export interface ThemeDefinition {
	id: ThemeId;
	label: string;
	description: string;
}

export const THEMES: readonly ThemeDefinition[] = [
	{ id: "pastel-sci-fi", label: "pastel sci-fi", description: "Current pastel telemetry palette" },
	{ id: "green-screen", label: "green screen", description: "1970s phosphor terminal / IBM 3270" },
	{ id: "amber-crt", label: "amber CRT", description: "1980s amber monochrome monitor" },
	{ id: "monokai", label: "Monokai", description: "2006 TextMate and Sublime classic" },
	{ id: "solarized-dark", label: "Solarized dark", description: "2011 precision terminal palette" },
	{ id: "dracula", label: "Dracula", description: "2013 dark purple developer theme" },
	{ id: "gruvbox", label: "Gruvbox", description: "2013–14 warm retro groove palette" },
	{ id: "nord", label: "Nord", description: "2016 arctic blue palette" },
	{ id: "tokyo-night", label: "Tokyo Night", description: "2019 neon night developer theme" },
	{ id: "catppuccin-mocha", label: "Catppuccin Mocha", description: "2021 soothing pastel dark flavor" },
];

export const SEGMENTS: readonly SegmentDefinition[] = [
	{ id: "cwd", label: "current-dir", description: "Current working directory" },
	{ id: "git-branch", label: "git-branch", description: "Current Git branch" },
	{ id: "git-worktree", label: "git-worktree", description: "Current linked Git worktree name or no-worktree status" },
	{ id: "model", label: "model", description: "Current model name" },
	{ id: "thinking", label: "reasoning", description: "Current thinking level" },
	{ id: "run-state", label: "run-state", description: "Ready, working, or thinking state" },
	{ id: "input", label: "input-tokens", description: "Accumulated input tokens" },
	{ id: "output", label: "output-tokens", description: "Accumulated output tokens" },
	{ id: "cache-read", label: "cache-read", description: "Accumulated cache-read tokens" },
	{ id: "cache-write", label: "cache-write", description: "Accumulated cache-write tokens" },
	{ id: "cache-hit", label: "cache-hit", description: "Prompt cache hit rate" },
	{ id: "context", label: "context", description: "Context window usage" },
	{ id: "session-cost", label: "session-cost", description: "Estimated session cost" },
	{ id: "task-progress", label: "task-progress", description: "Progress published by other Pi extensions" },
	{
		id: "subscription-quota",
		label: "subscription-quota",
		description: "Codex or Anthropic subscription quota when available",
	},
];

export interface StatuslineConfig {
	version: 2;
	theme: ThemeId;
	segments: SegmentId[];
	quotaRefreshIntervalMs: number;
}

const DEFAULT_SEGMENTS: SegmentId[] = [
	"cwd",
	"git-branch",
	"git-worktree",
	"model",
	"thinking",
	"input",
	"output",
	"cache-read",
	"cache-write",
	"cache-hit",
	"context",
	"session-cost",
	"task-progress",
	"subscription-quota",
];

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const CONFIG_FILE_NAME = "pi-cost-transparency-statusline.json";

export function getConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

export function createDefaultConfig(): StatuslineConfig {
	return {
		version: 2,
		theme: "pastel-sci-fi",
		segments: [...DEFAULT_SEGMENTS],
		quotaRefreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
	};
}

export function listSegments(): readonly SegmentDefinition[] {
	return SEGMENTS;
}

export function listThemes(): readonly ThemeDefinition[] {
	return THEMES;
}

export function isThemeId(value: string): value is ThemeId {
	return THEMES.some((theme) => theme.id === value);
}

export function isSegmentId(value: string): value is SegmentId {
	return SEGMENTS.some((segment) => segment.id === value);
}

export function normalizeConfig(value: unknown): StatuslineConfig {
	const fallback = createDefaultConfig();
	if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;

	const input = value as Record<string, unknown>;
	const theme = typeof input.theme === "string" && isThemeId(input.theme) ? input.theme : fallback.theme;
	const rawSegments = Array.isArray(input.segments) ? input.segments : fallback.segments;
	const selected = new Set(rawSegments.filter((segment): segment is SegmentId => typeof segment === "string" && isSegmentId(segment)));
	const segments = SEGMENTS.map((segment) => segment.id).filter((segment) => selected.has(segment));
	const refresh = typeof input.quotaRefreshIntervalMs === "number" ? input.quotaRefreshIntervalMs : fallback.quotaRefreshIntervalMs;

	return {
		version: 2,
		theme,
		segments,
		quotaRefreshIntervalMs: Number.isFinite(refresh)
			? Math.max(10_000, Math.min(10 * 60_000, Math.round(refresh)))
			: fallback.quotaRefreshIntervalMs,
	};
}

export function loadConfig(path = getConfigPath()): StatuslineConfig {
	if (!existsSync(path)) return createDefaultConfig();
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return createDefaultConfig();
	}
}

/** Persist user preferences atomically so a running Pi session never reads a partial JSON file. */
export function saveConfig(config: StatuslineConfig, path = getConfigPath()): void {
	const normalized = normalizeConfig(config);
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = join(dirname(path), `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
	try {
		writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		renameSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

export function setTheme(config: StatuslineConfig, theme: ThemeId): StatuslineConfig {
	return normalizeConfig({ ...config, theme });
}

export function setSegment(config: StatuslineConfig, id: SegmentId, enabled: boolean): StatuslineConfig {
	const selected = new Set(config.segments);
	if (enabled) selected.add(id);
	else selected.delete(id);
	return normalizeConfig({ ...config, segments: SEGMENTS.map((segment) => segment.id).filter((segment) => selected.has(segment)) });
}

export function isSegmentEnabled(config: StatuslineConfig, id: SegmentId): boolean {
	return config.segments.includes(id);
}

export function describeConfig(config: StatuslineConfig): string {
	const theme = THEMES.find((item) => item.id === config.theme);
	const themeLine = `theme: ${theme?.label ?? config.theme}`;
	return [themeLine, ...SEGMENTS.map((segment) => `${config.segments.includes(segment.id) ? "✓" : " "} ${segment.label} — ${segment.description}`)].join("\n");
}
