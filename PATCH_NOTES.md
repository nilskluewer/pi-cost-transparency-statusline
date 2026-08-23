# Patch notes

## Next release

### Added

- Added configurable statusline items through `/statusline`.
- Added `[x]` and `[]` checkbox indicators to the statusline selector.
- Added task progress and extension-status display.
- Added Git worktree identity next to the Git branch in the statusline.
- Added Codex subscription quota support through the local Codex app server.
- Added Claude/Anthropic subscription quota support when provider rate-limit data is available.
- Added quota reset countdowns and Codex-style `weekly % left` wording.
- Added configuration and statusline preview screenshots.

### Changed

- The command surface is now intentionally limited to `/statusline`.
- Quota percentages are clearly labelled as remaining percentage rather than used percentage.
- Statusline preferences are persisted and can be changed without editing configuration files.

### Notes

- Codex quota requires ChatGPT OAuth authentication in the local Codex CLI.
- API-key authentication does not expose subscription quota data.
- Anthropic/Claude quota is shown only when Pi receives the relevant provider data.
