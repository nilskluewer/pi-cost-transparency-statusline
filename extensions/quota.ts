import { spawn } from "node:child_process";

export type QuotaProvider = "codex" | "anthropic";

export interface QuotaWindow {
	key: string;
	label: string;
	usedPercent: number;
	resetAt?: number;
}

export interface QuotaSnapshot {
	provider: QuotaProvider;
	plan?: string;
	windows: QuotaWindow[];
	observedAt: number;
}

const CODEX_SHORT_WINDOW_MINUTES = 5 * 60;
const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function timestampValue(value: unknown): number | undefined {
	const numeric = numberValue(value);
	if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function durationLabel(minutes: number | undefined, fallback: string): string {
	if (minutes === CODEX_SHORT_WINDOW_MINUTES) return "5h";
	if (minutes === CODEX_WEEKLY_WINDOW_MINUTES) return "7d";
	if (minutes === undefined || minutes <= 0) return fallback;
	if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function parseCodexWindow(value: unknown, fallbackKey: string, fallbackLabel: string): QuotaWindow | undefined {
	const window = asRecord(value);
	if (!window) return undefined;
	const usedPercent = numberValue(window.usedPercent ?? window.used_percent ?? window.used);
	if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return undefined;
	const minutes = numberValue(
		window.windowDurationMins ??
			window.window_duration_mins ??
			window.windowMinutes ??
			window.window_minutes,
	);
	return {
		key: minutes === CODEX_SHORT_WINDOW_MINUTES ? "five-hour" : minutes === CODEX_WEEKLY_WINDOW_MINUTES ? "weekly" : fallbackKey,
		label: durationLabel(minutes, fallbackLabel),
		usedPercent: clampPercent(usedPercent),
		...(timestampValue(window.resetsAt ?? window.resets_at ?? window.resetAt ?? window.reset_at) !== undefined
			? { resetAt: timestampValue(window.resetsAt ?? window.resets_at ?? window.resetAt ?? window.reset_at) }
			: {}),
	};
}

/** Parse the official Codex app-server account/rateLimits/read response. */
export function parseCodexQuota(value: unknown, observedAt = Date.now()): QuotaSnapshot | undefined {
	const root = asRecord(value);
	const result = asRecord(root?.result) ?? root;
	const rateLimits = asRecord(result?.rateLimits) ?? asRecord(result?.rate_limits);
	if (!rateLimits) return undefined;

	const windows = [
		parseCodexWindow(rateLimits.primary, "five-hour", "5h"),
		parseCodexWindow(rateLimits.secondary, "weekly", "7d"),
	].filter((window): window is QuotaWindow => Boolean(window));
	if (windows.length === 0) return undefined;

	const plan = rateLimits.planType ?? rateLimits.plan_type ?? result?.planType ?? result?.plan_type;
	return {
		provider: "codex",
		plan: typeof plan === "string" && plan ? plan : undefined,
		windows: deduplicateWindows(windows),
		observedAt,
	};
}

function normalizeUtilization(value: unknown): number | undefined {
	const parsed = numberValue(value);
	if (parsed === undefined || parsed < 0) return undefined;
	const percent = parsed <= 1 ? parsed * 100 : parsed;
	return percent <= 100 ? percent : undefined;
}

function headerMap(headers: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function firstHeader(headers: Record<string, string>, names: string[]): string | undefined {
	for (const name of names) {
		const value = headers[name.toLowerCase()];
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

/** Parse Anthropic's subscription rate-limit response headers when Pi exposes them. */
export function parseAnthropicQuotaHeaders(
	headers: Readonly<Record<string, string>>,
	observedAt = Date.now(),
): QuotaSnapshot | undefined {
	const normalized = headerMap(headers);
	const definitions = [
		{
			key: "five-hour",
			label: "5h",
			utilization: ["anthropic-ratelimit-unified-5h-utilization"],
			reset: ["anthropic-ratelimit-unified-5h-reset"],
		},
		{
			key: "weekly",
			label: "7d",
			utilization: ["anthropic-ratelimit-unified-7d-utilization"],
			reset: ["anthropic-ratelimit-unified-7d-reset"],
		},
	] as const;

	const windows = definitions.flatMap((definition) => {
		const usedPercent = normalizeUtilization(firstHeader(normalized, [...definition.utilization]));
		if (usedPercent === undefined) return [];
		const resetAt = timestampValue(firstHeader(normalized, [...definition.reset]));
		return [{ key: definition.key, label: definition.label, usedPercent, ...(resetAt === undefined ? {} : { resetAt }) }];
	});
	return windows.length === 0 ? undefined : { provider: "anthropic", windows, observedAt };
}

/** Parse the JSON payload Claude Code sends to its configured status-line command. */
export function parseClaudeStatuslineQuota(value: unknown, observedAt = Date.now()): QuotaSnapshot | undefined {
	const root = asRecord(value);
	const rateLimits = asRecord(root?.rate_limits) ?? asRecord(root?.rateLimits);
	if (!rateLimits) return undefined;
	const windows = ([
		["five-hour", "5h"],
		["seven_day", "7d"],
	] as const).flatMap(([key, label]) => {
		const window = asRecord(rateLimits[key]);
		const usedPercent = normalizeUtilization(window?.used_percentage ?? window?.usedPercent ?? window?.used);
		if (!window || usedPercent === undefined) return [];
		const resetAt = timestampValue(window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt);
		return [{ key: key === "seven_day" ? "weekly" : key, label, usedPercent, ...(resetAt === undefined ? {} : { resetAt }) }];
	});
	return windows.length === 0 ? undefined : { provider: "anthropic", windows, observedAt };
}

function deduplicateWindows(windows: QuotaWindow[]): QuotaWindow[] {
	const seen = new Set<string>();
	return windows.filter((window) => {
		if (seen.has(window.key)) return false;
		seen.add(window.key);
		return true;
	});
}

interface RpcMessage {
	id?: unknown;
	result?: unknown;
	error?: unknown;
}

/**
 * Query the locally installed Codex CLI. This uses Codex's own ChatGPT OAuth session and does not
 * make a model request or read Pi's credentials. API-key authentication does not expose quota data.
 */
export function fetchCodexQuota(timeoutMs = 5_000): Promise<QuotaSnapshot | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		let buffer = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn("codex", ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "ignore"],
			env: process.env,
		});

		const finish = (value: QuotaSnapshot | undefined) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (!child.killed) child.kill();
			resolve(value);
		};

		const send = (message: Record<string, unknown>) => {
			try {
				child.stdin.write(`${JSON.stringify(message)}\n`);
			} catch {
				finish(undefined);
			}
		};

		child.on("error", () => finish(undefined));
		child.on("close", () => finish(undefined));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					try {
						const message = JSON.parse(line) as RpcMessage;
						if (message.id === 1) {
							send({ method: "initialized", params: {} });
							send({ id: 2, method: "account/rateLimits/read", params: {} });
						} else if (message.id === 2) {
							finish(parseCodexQuota(message.result));
						}
					} catch {
						// Ignore non-JSON diagnostics and continue waiting for the response.
					}
				}
				newline = buffer.indexOf("\n");
			}
		});

		timer = setTimeout(() => finish(undefined), timeoutMs);
		send({
			id: 1,
			method: "initialize",
			params: {
				clientInfo: {
					name: "pi-cost-transparency-statusline",
					title: "Pi cost transparency statusline",
					version: "0.3.0",
				},
			},
		});
	});
}

export function quotaRemaining(window: QuotaWindow): number {
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function formatQuota(snapshot: QuotaSnapshot, now = Date.now()): string {
	const provider = snapshot.provider === "codex" ? "Codex" : "Claude";
	const plan = snapshot.plan ? ` ${capitalize(snapshot.plan)}` : "";
	const windows = snapshot.windows.map((window) => {
		const remaining = Math.round(quotaRemaining(window));
		const reset = window.resetAt === undefined ? "" : ` · resets in ${formatReset(window.resetAt, now)}`;
		const label = window.key === "weekly" ? "weekly" : window.label;
		return `${label} ${remaining}% left${reset}`;
	});
	return `${provider}${plan} · ${windows.join(" · ")}`;
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function formatReset(resetAt: number, now: number): string {
	const remainingMs = Math.max(0, resetAt - now);
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	if (totalMinutes <= 0) return "now";

	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0 || days > 0) parts.push(`${hours}h`);
	if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
	return parts.join(" ");
}
