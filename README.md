# pi-compact-footer

Two [pi](https://github.com/earendil-works/pi) TUI extensions that replace the built-in three-line footer with a single dense line, and show live LLM throughput while a response streams.

Built-in footer:

```
~/project/angelina (main) • refactor-footer
↑12k ↓3.4k R98k CH92% 68%/200k (auto)      (anthropic) claude-sonnet-4 • high
⚡ TTFT 0.84s · ↓41 tok/s · ~130 tok
```

With these extensions:

```
~/project/angelina (main) • refactor-footer  ◎92.3% ¥0.019 68.0%/200k (auto)  ⚡ TTFT 0.84s · ↓41 tok/s · ~130 tok  (anthropic) claude-sonnet-4 • high
```

## What's in the box

### `compact-footer.ts`

Merges the footer's three lines into one and drops the readout you probably never look at.

- **One line, four blocks**: pwd/branch/session → stats → extension statuses → right-aligned model.
- **Stats** are `◎<cache hit %> <cost> <ctx%>/<window>`.
  - `◎` is the cache hit rate of the **latest** request (`cacheRead / (input + cacheRead + cacheWrite)`). Hidden until the first cached request.
  - Cost is the **cumulative** session cost. A leading `~` means it was estimated locally from the model's pricing table because the provider reported no cost (common with self-hosted gateways).
  - `(auto)` is appended only when auto-compaction is on **and** context usage is above 40%.
  - The context figure turns yellow above 70% and red above 90%.
- **Graceful degradation**: when the terminal is too narrow, blocks are dropped in a fixed order — provider prefix → session name → statuses (truncated, then dropped) → pwd. The stats block and the model label are given up last, and the stats themselves get truncated only in the final fallback.
- **Extension statuses** are preserved verbatim (including the `⚡` from `live-throughput-status.ts`), so any other extension that calls `ctx.ui.setStatus()` keeps working.

### `live-throughput-status.ts`

A lifecycle-aware replacement for an always-on `TTFT: waiting · Decode: waiting` status. The footer stays clean while pi is idle:

| Phase | Footer shows |
| --- | --- |
| idle | *(nothing)* |
| waiting for first token | `⚡ waiting · 2.4s` (dim, live counter) |
| streaming | `⚡ TTFT 0.84s · ↓41.3 tok/s · ~130 tok` (accent, live estimates) |
| settled | `⚡ TTFT 0.84s · ↑1.2k tok/s · ↓41.3 tok/s · 512 tok` (muted, clears after 8s) |

- `↑` / `↓` match pi's input/output convention — `↑` is prefill throughput, `↓` is decode throughput.
- Live numbers are **estimates** (`chars / 4`) until the provider reports real usage; the settled line uses the real token counts.
- The prefill rate includes cache-write tokens, since those are processed before the first token too.
- The first output token is excluded from the decode rate: it's the prefill's last step, not decode work.
- `agent_settled` is a safety net, so a cancelled or errored run never leaves a `waiting` status stuck in the footer.

## Install

From git (recommended while the package is young):

```bash
pi install git:github.com/ycwfmelt/pi-compact-footer
```

From a local clone:

```bash
pi install /path/to/pi-compact-footer
```

Or try it without installing:

```bash
pi -e /path/to/pi-compact-footer/extensions/compact-footer.ts \
   -e /path/to/pi-compact-footer/extensions/live-throughput-status.ts
```

`pi install` writes to your user settings (`~/.pi/agent/settings.json`); add `--local` to write to the project's `.pi/settings.json` instead. Use `pi list` to see installed packages and `pi remove <source>` to uninstall.

> **Upgrading from a hand-copied setup:** if you previously dropped these files into `~/.pi/agent/extensions/`, delete them before installing the package. Both copies would load and you'd get two footers fighting over the same row.

## Configuration

Constants live at the top of each file — edit them in your clone (or fork) to taste.

`compact-footer.ts`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `AUTO_HINT_MIN_PERCENT` | `40` | Context % above which `(auto)` appears |
| `CURRENCY` | `"¥"` | Cost symbol; pi's cost pipeline is currency-agnostic, so change this to `"$"` if your model rates are USD |
| `CACHE_HIT_ICON` | `"◎"` | Icon before the cache hit rate |
| `MIN_PAD` | `2` | Minimum gap before the right-aligned model |
| `MIN_STATUS_WIDTH` | `16` | Below this, statuses are dropped instead of truncated |

`live-throughput-status.ts`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `CHARS_PER_TOKEN` | `4` | Divisor for live token estimates |
| `UPDATE_INTERVAL_MS` | `250` | Throttle for live decode updates |
| `WAITING_TICK_MS` | `500` | Tick rate of the "waiting" counter |
| `LINGER_MS` | `8000` | How long the settled line stays before clearing |
| `MIN_DECODE_SECONDS` | `0.25` | Minimum decode window before showing a tok/s estimate |

## Compatibility

Written against pi `1.3.0` and using only public extension APIs:

- `ctx.getContextUsage()`, `ctx.sessionManager.getEntries()`, `ctx.sessionManager.getCwd()`, `ctx.sessionManager.getSessionName()`, `ctx.model`, `ctx.modelRegistry`
- `footerData.getGitBranch()`, `getExtensionStatuses()`, `getAvailableProviderCount()`, `onBranchChange()`
- `pi.getSettings()`, `ctx.ui.setFooter()`, `ctx.ui.setStatus()`, `ctx.ui.theme`
- events `before_provider_request`, `message_start`, `message_update`, `message_end`, `agent_settled`, `session_start`, `session_shutdown`, `model_select`

No internal `dist/` paths are imported, so pi upgrades shouldn't break these. If a future pi changes the footer API, `setFooter()` is the only entry point to fix.

## Development

```bash
bun install
bun run typecheck
bun test
```

The repo pins the public npm registry in `.npmrc` so the committed `bun.lock` stays registry-neutral. It has to be a project-level `.npmrc` rather than `bunfig.toml`: bun ignores `bunfig.toml`'s `[install].registry` when `~/.npmrc` already sets one.

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are `peerDependencies` (pi provides them at runtime) and `devDependencies` (so the typechecker can resolve them). pi installs packages with `--omit=dev --omit=peer`, so the dev copies never reach your pi install.

## License

MIT
