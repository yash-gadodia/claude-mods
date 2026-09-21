import type { Register, EngineInterface } from 'claude-code'

// The laptop orchestrates, the mini executes. Heavy work — test suites, builds, Docker stacks —
// belongs on ssh mini, and every session otherwise has to be reminded of that. This mod rewrites
// the Bash call instead: same command, wrapped with the non-interactive PATH export and a cd into
// the matching directory on the mini.
//
// Per-repo override at <repo>/.claude/mini-offload.json:
//   { "remoteRoot": "/Users/yash/dev/thing", "extra": ["^bun run gate"], "never": ["^bun run dev"] }
// With no config the mini's path is assumed to match the laptop's, which is true for ~/dev.
//
// The mini runs a DIFFERENT checkout, which is the whole hazard: on 20-09-2026 it was 53 commits
// behind ragtag-ragnarok's main and still answering `npm test` with a green, for code that was
// nowhere on it. A gate that reports on the wrong tree is worse than no gate. So a git repo is
// synced before anything is offloaded - HEAD is pushed to a scratch ref and the mini is reset onto
// it - and when it cannot be synced the command stays on the laptop and says why. Uncommitted work
// can never be sent, so a dirty tree always runs here.

// The remote host and its PATH export are the only machine-specific things here; both come from
// the plugin's userConfig so this works for anyone with an ssh alias to a second machine.
let HOST = 'mini'
let REMOTE_PATH = 'export PATH=/opt/homebrew/bin:$PATH'
const MODE_KEY = 'mini-offload:mode'
const TEN_MINUTES = 600000

const HEAVY = [
  /\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b/,
  /\b(bun|npm|pnpm|yarn)\s+(run\s+)?build\b/,
  /\b(vitest|jest|playwright|cypress)\b/,
  /\b(pytest|tox|nox)\b/,
  /\bgo\s+(test|build)\b/,
  /\bcargo\s+(test|build|clippy)\b/,
  /\bdocker\s+(compose|build)\b/,
  /\bcolima\b/,
  /\bturbo\s+run\b/,
  /\bnext\s+build\b/,
  /\btsc\s+(-b|--build)\b/,
  /\bmake\s+(test|build|check|gate)\b/,
]

// Whether a directory exists on the mini, asked once per path per session: sending a command to a
// path the mini does not have is worse than running it here, because `cd` fails and the rest is
// skipped with only a confusing error to show for it.
const remoteRootOk = new Map<string, boolean>()

// Synced once per commit per remote path: a loop of test runs on one commit syncs on the first.
const synced = new Set<string>()

// A command that already leaves this machine, or that only makes sense here, is left alone.
const NEVER = [
  /\bssh\b/,
  /\bmini\b/,
  /\bgit\s+(push|pull|fetch|clone)\b/,
  /\b(vercel|wrangler|railway|flyctl|netlify)\b/,
  /\b(bun|npm|pnpm|yarn)\s+(run\s+)?dev\b/,
  /--watch\b/,
]

type Config = { remoteRoot?: string; extra?: string[]; never?: string[] }
type Mode = 'ask' | 'always' | 'off'

let mode: Mode = 'ask'
let interactive = false
// answered once per session per command shape, so a loop of test runs asks once
const declined = new Set<string>()

const isMode = (value: unknown): value is Mode => value === 'ask' || value === 'always' || value === 'off'

const readConfig = async ($: EngineInterface, root: string): Promise<Config> => {
  const path = `${root}/.claude/mini-offload.json`
  if (!(await $.fs.exists(path).catch(() => false))) return {}
  try {
    return JSON.parse(await $.fs.read(path)) as Config
  } catch (err) {
    $.ui.log(`mini-offload: ${path} is not valid JSON: ${err}`)
    return {}
  }
}

const matches = (command: string, extra: string[] = [], never: string[] = []) => {
  if (NEVER.some(re => re.test(command))) return false
  if (never.some(source => new RegExp(source).test(command))) return false
  return HEAVY.some(re => re.test(command)) || extra.some(source => new RegExp(source).test(command))
}

// Single-quote the whole remote script, escaping any single quote inside it the shell way.
const quote = (script: string) => `'${script.replace(/'/g, `'\\''`)}'`

const remoteCommand = (command: string, remoteRoot: string) =>
  `ssh ${HOST} ${quote(`${REMOTE_PATH}; cd ${quote(remoteRoot)} && ${command}`)}`

const remoteHas = async ($: EngineInterface, remoteRoot: string): Promise<boolean> => {
  const known = remoteRootOk.get(remoteRoot)
  if (known !== undefined) return known
  const r = await $.process
    .run(['ssh', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', HOST, `test -d ${quote(remoteRoot)}`], { timeoutMs: 8000 })
    .catch(() => undefined)
  const ok = r?.exitCode === 0
  remoteRootOk.set(remoteRoot, ok)
  return ok
}

const git = async ($: EngineInterface, cwd: string, args: string[]): Promise<string | undefined> => {
  const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 60000 }).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() : undefined
}

type Sync = { ok: true; note?: string } | { ok: false; why: string }

// Put the laptop's HEAD on the mini, or explain why the command must stay here. The scratch ref is
// per branch and force-pushed: it is ours, nobody builds on it, and it keeps the sync to one delta.
const syncToMini = async ($: EngineInterface, root: string, remoteRoot: string): Promise<Sync> => {
  const sha = await git($, root, ['rev-parse', 'HEAD'])
  if (!sha) return { ok: true, note: `${root} is not a git checkout, so nothing was synced - the mini ran whatever it already had there.` }

  const key = `${remoteRoot}@${sha}`
  if (synced.has(key)) return { ok: true }

  const dirty = await git($, root, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty === undefined) return { ok: false, why: `git status failed in ${root}` }
  if (dirty !== '') {
    return {
      ok: false,
      why: 'the working tree has uncommitted changes. They cannot be sent to the mini, and a run there would quietly report on the last commit instead of the code being edited.',
    }
  }

  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD'
  const ref = `_offload/${branch.replace(/[^A-Za-z0-9._\/-]/g, '-')}`
  const pushed = await $.process
    .run(['git', '-C', root, 'push', '--force', '--quiet', 'origin', `HEAD:refs/heads/${ref}`], { timeoutMs: 120000 })
    .catch(() => undefined)
  if (pushed?.exitCode !== 0) return { ok: false, why: `pushing HEAD to origin ${ref} failed, so the mini cannot be given this commit` }

  // -uno: untracked files on the mini are its own business, tracked edits are not ours to discard.
  const script = [
    `cd ${quote(remoteRoot)}`,
    `test -z "$(git status --porcelain -uno)" || { echo __DIRTY__; exit 3; }`,
    `git fetch --quiet origin ${ref}`,
    `git reset --hard --quiet FETCH_HEAD`,
    'git rev-parse HEAD',
  ].join(' && ')
  const r = await $.process.run(['ssh', HOST, quote(`${REMOTE_PATH}; ${script}`)], { timeoutMs: 180000 }).catch(() => undefined)

  if (r?.stdout.includes('__DIRTY__')) {
    return { ok: false, why: `${HOST}:${remoteRoot} has uncommitted tracked changes of its own, and resetting it onto this commit would throw them away` }
  }
  if (r?.exitCode !== 0 || !r.stdout.includes(sha)) {
    return { ok: false, why: `${HOST} could not be reset onto ${sha.slice(0, 7)}` }
  }

  synced.add(key)
  return { ok: true, note: `mini-offload synced ${HOST}:${remoteRoot} to ${sha.slice(0, 7)} before running this.` }
}

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'mini-offload'
let disabled = false
const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === MOD)
  return disabled
}

export const register: Register = (on, options) => {
  if (typeof options.host === 'string' && options.host.trim()) HOST = options.host.trim()
  if (typeof options.remotePath === 'string' && options.remotePath.trim()) REMOTE_PATH = options.remotePath.trim()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    interactive = e.isInteractive
    const saved = await $.store.get(MODE_KEY).catch(() => undefined)
    if (isMode(saved)) mode = saved
    await $.command
      .register({
        name: 'mini',
        description: 'Where heavy commands run: always on the mini, ask each time, or off (mini-offload)',
        argumentHint: '[always | ask | off | status]',
        immediate: true,
      })
      .catch(err => $.ui.log(`mini-offload: /mini not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'mini' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'status' || arg === '') {
      return {
        text: [
          `mini-offload is ${mode}`,
          '  always  heavy commands go to the mini with no prompt',
          '  ask     heavy commands prompt first (default)',
          '  off     everything runs on this laptop',
          declined.size ? `\ndeclined this session: ${declined.size} command shape(s)` : '',
        ].join('\n'),
      }
    }
    if (!isMode(arg)) return { text: `mini: no mode called "${arg}" — use always, ask, off or status` }
    mode = arg
    declined.clear()
    await $.store.set(MODE_KEY, mode).catch(err => $.ui.log(`mini-offload: store write failed: ${err}`))
    return { text: `mini-offload set to ${mode}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (mode === 'off' || e.run_in_background) return next(e)

    const repo = await $.session.repo().catch(() => null)
    const root = repo?.root ?? (await $.session.cwd())
    const config = await readConfig($, root)
    if (!matches(e.command, config.extra, config.never)) return next(e)

    const key = e.command.trim().slice(0, 120)
    if (declined.has(key)) return next(e)

    const remoteRoot = config.remoteRoot ?? root
    if (!(await remoteHas($, remoteRoot))) {
      declined.add(key)
      const r = await next(e)
      if ('deny' in r) return r
      return {
        ...r,
        context: [
          ...(r.context ?? []),
          `mini-offload left this on the laptop: ${HOST} has no directory ${remoteRoot}, so running it there would only have failed at cd.`,
          `If this work belongs on the mini, get the code there and set {"remoteRoot": "<path on the mini>"} in ${root}/.claude/mini-offload.json.`,
        ],
      }
    }

    if (mode === 'ask') {
      if (!interactive) return next(e)
      const answer = await $.ui
        .ask(`Run this on the mini instead of the laptop?\n  ${key}`, {
          header: 'mini-offload',
          options: ['Run on the mini', 'Run here', 'Always the mini this session', 'Stop asking this session'],
        })
        .catch(() => 'Run here')
      if (answer === 'Run here') {
        declined.add(key)
        return next(e)
      }
      if (answer === 'Stop asking this session') {
        mode = 'off'
        return next(e)
      }
      if (answer === 'Always the mini this session') mode = 'always'
    }

    // The mini must be running THIS commit, or its answer is about other code.
    const sync = await syncToMini($, root, remoteRoot)
    if (!sync.ok) {
      declined.add(key)
      $.ui.toast(`mini-offload: staying on the laptop (${sync.why})`)
      const local = await next(e)
      if ('deny' in local) return local
      return {
        ...local,
        context: [
          ...(local.context ?? []),
          `mini-offload ran this on the LAPTOP, not on ${HOST}: ${sync.why}`,
        ],
      }
    }

    const rewritten = remoteCommand(e.command, remoteRoot)
    $.ui.toast(`mini-offload: running on ${HOST} (${remoteRoot})`)

    const r = await next({ ...e, command: rewritten, timeout: Math.max(e.timeout ?? 0, TEN_MINUTES) })
    if ('deny' in r) return r

    const note =
      r.isError && /Could not resolve hostname|Connection (refused|timed out)|Host key/i.test(r.text ?? '')
        ? `mini-offload sent this to ${HOST} and ssh could not reach it. Re-run the command as written locally, and tell the user the mini is unreachable.`
        : [
            `mini-offload ran this on ${HOST} in ${remoteRoot}, not on the laptop.`,
            sync.note ?? `${HOST} was already on this commit.`,
            `The command actually run was: ${rewritten}`,
          ].join(' ')
    return { ...r, context: [...(r.context ?? []), note] }
  })
}
