import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

// Pi supplies these peer dependencies to extensions. Also support a global Pi
// install, as used by the package smoke test, without installing a second copy.
let hostParentURL;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith("@earendil-works/pi-")) throw error;
      hostParentURL ??= pathToFileURL(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent/dist/index.js")).href;
      return nextResolve(specifier, { ...context, parentURL: hostParentURL });
    }
  },
});

const agentDir = mkdtempSync(join(tmpdir(), "pi-statusline-test-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const { default: statusline } = await import("../extensions/statusline.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { createDefaultConfig } = await import("../extensions/config.ts");

async function createFooter({ provider = "github-copilot", id = "gpt-6.1-sol", cwd = process.cwd(), branch = "main", segments, noModel = false } = {}) {
  const config = createDefaultConfig();
  if (segments) config.segments = segments;
  writeFileSync(join(agentDir, "pi-cost-transparency-statusline.json"), JSON.stringify(config));
  const handlers = new Map();
  let footer;
  const ctx = {
    cwd,
    mode: "tui",
    model: noModel ? undefined : { provider, id, cost: { cacheWrite: 0 } },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => undefined,
    ui: {
      setFooter(factory) {
        if (!factory) return;
        footer = factory({ requestRender() {} }, {}, {
          getGitBranch: () => branch,
          getExtensionStatuses: () => new Map(),
          onBranchChange: () => () => {},
        });
      },
    },
  };
  statusline({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {},
    getThinkingLevel: () => "medium",
  });
  await handlers.get("session_start")({}, ctx);
  return { footer, ctx, handlers, header: (width) => stripVTControlCharacters(footer.render(width)[0] ?? "") };
}

// Oracles: the requested provider identity comes from ctx.model.provider, not
// the model ID; Pi's TUI contract requires every rendered line to fit width.
// Wrong implementations rejected: fixed MODEL_COLUMN, provider inferred from
// the model ID, stale provider after a switch, and dangling segment separators.
test("model item includes the selected provider, including custom providers", async () => {
  for (const provider of ["github-copilot", "google-vertex", "anthropic", "openai-codex", "company-gateway"]) {
    const { header } = await createFooter({ provider });
    assert.ok(header(180).includes(`◈ ${provider}/gpt-6.1-sol · medium`), header(180));
  }
});

test("resize shrinks the leader and preserves the complete provider/model/reasoning", async () => {
  const { header, footer } = await createFooter();
  const expected = "◈ github-copilot/gpt-6.1-sol · medium";
  const wide = header(180);
  for (const width of [180, 160, 120, 100, 80, 60, 50, 42, 180]) {
    const line = header(width);
    assert.ok(line.endsWith(expected), `width ${width}: ${line}`);
    assert.equal(visibleWidth(line), width, `header should use available width ${width}`);
    for (const row of footer.render(width)) assert.ok(visibleWidth(row) <= width);
  }
  assert.ok((wide.match(/┄/g) ?? []).length > (header(160).match(/┄/g) ?? []).length);
  assert.equal(header(180), wide, "growing the terminal restores the original header");
});

test("very narrow widths stay bounded and prefer model information over directory", async () => {
  const { header, footer } = await createFooter();
  for (const width of [0, 1, 2, 3, 10, 20, 34, 35, 36, 37, 38, 39]) {
    for (const row of footer.render(width)) assert.ok(visibleWidth(row) <= width, `width ${width}: ${row}`);
    const line = header(width);
    assert.ok(!line.includes("┄"), `no leader without directory space: ${line}`);
    if (width >= 2) assert.ok(line.startsWith("◈ "), `width ${width}: ${line}`);
  }
});

test("provider updates when the selected model changes, without duplicating ID prefixes", async () => {
  const { header, ctx, handlers } = await createFooter();
  ctx.model = { provider: "google-vertex", id: "publishers/google/models/gemini-pro", cost: { cacheWrite: 0 } };
  await handlers.get("model_select")({}, ctx);
  const line = header(120);
  assert.ok(line.endsWith("◈ google-vertex/gemini-pro · medium"), line);
  assert.ok(!line.includes("github-copilot"));
});

test("missing model has a clear fallback", async () => {
  const { header } = await createFooter({ noModel: true });
  assert.ok(header(100).endsWith("◈ no model · medium"));
  assert.ok(!header(100).includes("undefined"));
});

test("disabled header segments leave no dangling dots or separators", async () => {
  const cases = [
    { segments: ["model"], expected: "◈ github-copilot/gpt-6.1-sol" },
    { segments: ["thinking"], expected: "medium" },
    { segments: ["run-state"], expected: "Ready" },
    { segments: ["cwd"], expected: "/project" },
    { segments: ["git-branch"], expected: "⎇ main" },
    { segments: ["git-worktree"], expected: "⌂ no worktree" },
    { segments: [], expected: "" },
  ];
  for (const { segments, expected } of cases) {
    const { header } = await createFooter({ cwd: "/project", segments });
    assert.equal(header(100), expected);
  }
});

test("long Git identity and wide Unicode paths cannot displace the model", async () => {
  const expected = "◈ github-copilot/gpt-6.1-sol · medium";
  for (const branch of ["main", "feature/修复", "feature/".repeat(20)]) {
    const { header, footer } = await createFooter({ cwd: "/项目/🚀/e\u0301/".repeat(10), branch });
    for (let width = 0; width <= 240; width++) {
      if (width >= visibleWidth(expected)) assert.ok(header(width).endsWith(expected), header(width));
      for (const row of footer.render(width)) assert.ok(visibleWidth(row) <= width);
    }
  }
});
