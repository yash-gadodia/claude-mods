# claude-mods

> Mods that keep an agent honest — plus a few that make the terminal fun.

`claude-code` · `mod` · `function-hooks` · `typescript` · `macos`

[![License: MIT](https://img.shields.io/badge/License-MIT-d97757.svg)](LICENSE)
![Claude Code — mod](https://img.shields.io/badge/Claude%20Code-mod-d97757)

```
usage  max  volty  opus-5  5h 34%  7d 12%  ctx 41% 82k  $1.23
scope: 3/4 files
 ▸
```
<sub>Nine mods, each drawing or guarding its own slice of the session. Above: `usage-band` and `scope-guard`.</sub>

## Why

Claude Code will tell you a deploy worked because `git push` exited 0. It will turn a one-line
fix into a nine-file refactor and never mention it. Written rules in `CLAUDE.md` help until the
model forgets them, and you find out on the deploy that breaks.

These are the same rules, moved out of prose and into the engine — where they hold whether or not
the model remembers.

## What a mod is

A **mod** is a Claude Code plugin whose behaviour lives in a TypeScript hooks module —
`register(on, options)` wiring handlers onto engine events (`tool.call`, `ui.render`,
`turn.complete`) rather than markdown the model reads. A mod can deny a tool call, rewrite it in
flight, draw above the prompt, or put evidence in front of the model that it cannot argue with.

Every mod here is source you can read in one sitting. None of them phone home: there is no
`$.http.fetch` anywhere in this repo.

## Install

Function hooks are behind a flag. Set it first, in your shell profile or `settings.json` `env`:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Then, in Claude Code:

```
/plugin marketplace add yash-gadodia/claude-mods
/plugin install scope-guard@claude-mods
```

Install only what you want — each mod is independent. Update with
`claude plugin update <name>@claude-mods`.

## The mods

### Discipline

| Mod | What it does |
|---|---|
| **scope-guard** | Counts the distinct files one turn edits. At the threshold it stops and makes the goal get restated, so a small ask cannot quietly become a refactor. `/scope` sets it. |
| **deploy-verify** | After a deploy command succeeds, curls the live URL with cache-busting and puts the verdict in the model's context. A deploy cannot be claimed without evidence. |
| **mini-offload** | Rewrites heavy Bash commands (test suites, builds, Docker) to run on a second machine over ssh — syncing the commit there first, because the remote checkout is the real hazard. `/mini` sets always, ask, or off. |

### Instruments

| Mod | What it does |
|---|---|
| **usage-band** | The 5-hour and 7-day limit windows, this session's context fill and cost, above the prompt. Nudges you to `/clear` when the window gets expensive. |
| **money-band** | Liquid assets, CPF, debt and month-to-date spend, read from a pair of SQLite databases over ssh. Every figure is the database's own; nothing is estimated. |
| **copy-band** | Click-to-copy buttons above the prompt for every code block and quoted draft in the last answer, plus a durable stash of older ones. Copying runs `pbcopy` directly — no model turn. |
| **chrome-switch** | Switches the Claude in Chrome extension between named browser profiles using `select_browser`, which needs no approval click. `/chromep` maps them. |

### Fun

| Mod | What it does |
|---|---|
| **wod-band** | A pixel-art athlete above the prompt who does a rep every turn. The session is an AMRAP of thrusters, burpees and pull-ups. |
| **wod-timer** | 3, 2, 1, GO when you submit, a running gym clock while Claude works, and your split when the turn lands. |

## Turning them off

Every mod checks one environment variable before doing anything:

```bash
CLAUDE_MODS_DISABLE=all            # every mod in this repo becomes a pass-through
CLAUDE_MODS_DISABLE=scope-guard    # just that one
CLAUDE_MODS_DISABLE=wod-band,wod-timer
```

A disabled mod registers no command and every hook falls straight through to `next(e)`.

## Configuration

Mods that touch your machine declare their settings in `plugin.json` `userConfig`, so they are
editable through `/config` rather than by hand:

- **mini-offload** — `host` (ssh alias, default `mini`), `remotePath` (the PATH export prefixed to
  every offloaded command). Per-repo overrides live at `<repo>/.claude/mini-offload.json`.
- **money-band** — `host`, `networthDb`, `financeDb`. Expects SQLite databases with
  `accounts`/`balances` and `transactions` tables.
- **deploy-verify** — per-repo, at `<repo>/.claude/deploy-verify.json`:
  ```json
  { "url": "https://example.com", "matchFile": "VERSION" }
  ```
- **chrome-switch** — `~/.claude/chrome-browsers.json`, mapping labels to deviceIds.

## Design rules

The ones that survived contact with real sessions:

1. **A deny always carries the fix.** Blocking without saying what to do instead strands the model
   in a retry loop. Every refusal here names the next action.
2. **Never block when there is no way through.** If the only outcomes are "denied" and "denied
   again", let it run and say something instead.
3. **A render hook that throws takes the whole mod down with it.** Every band wraps its frame in
   `try/catch` and falls back to what was there.
4. **Hooks have roughly ten seconds.** Past that the engine drops the result silently. Slow work
   belongs on a timer, not in the call.
5. **Bands yield.** `e.props.hasSurvey` means the engine wants that slot; give it back.

## Requirements

Claude Code 2.1.271+ with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. macOS — `copy-band` shells out to
`pbcopy`, and `mini-offload`/`money-band` assume ssh and a Homebrew path on the remote.

## License

MIT
