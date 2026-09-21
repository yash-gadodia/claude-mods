/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

// After each Edit, Write, NotebookEdit or `sed -i` lands, the file's uncommitted hunk sits in a
// docked pane with [keep] and [revert]: a review the model never sees and a revert that costs no
// turn. The pane lists the files touched this turn, newest first, and empties at the next turn.
//
// A press is answered in `ui.press` by the Button's key, not its closure: a closure belongs to one
// drawing and a press during a redraw is dropped, while the hook still sees the key.

const MOD = 'diff-review'
const PANE_ID = 'diff-review'
const PANE_TITLE = 'diff'
const ENABLED_KEY = 'diff-review:enabled'
const AUTO_OPEN_MIN_COLUMNS = 144
const CODE_MAX_CHARS = 10000
const GIT_TIMEOUT_MS = 5000

type Hunk = { id: number; path: string; rel: string; diff: string; kind: 'tracked' | 'untracked' | 'new' }

let hunks: Hunk[] = []
let nextId = 1
let enabled = true
let interactive = false
let cwd = ''
let columns: number | undefined
let paneOpen = false
let paneDrawn = false
let closedByPerson = false
let armed: { id: number; timer: { cancel: () => void } } | undefined
const ARM_MS = 10000

const TOKEN = /'[^']*'|"[^"]*"|\S+/g
const SED_VALUED = ['-e', '-f', '--expression', '--file']

// The files a `sed -i` writes: every segment of the command that starts with sed and carries -i,
// its flags dropped, the script dropped unless -e or -f named it.
export const sedTargets = (command: string): string[] => {
  const out: string[] = []
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const tokens = (seg.match(TOKEN) ?? []).filter(t => t !== "''" && t !== '""')
    const at = tokens.findIndex(t => t === 'sed')
    if (at < 0 || !tokens.slice(at + 1).some(t => /^(-i|--in-place)/.test(t))) continue
    const rest: string[] = []
    let scripted = false
    for (let i = at + 1; i < tokens.length; i++) {
      const t = tokens[i] ?? ''
      if (SED_VALUED.includes(t)) {
        scripted = true
        i++
      } else if (t.startsWith('-')) continue
      else rest.push(t.replace(/^(['"])(.*)\1$/, '$2'))
    }
    out.push(...(scripted ? rest : rest.slice(1)).filter(t => t !== '' && !/[*?$]/.test(t)))
  }
  return out
}

const absolute = (path: string) => (path.startsWith('/') ? path : `${cwd}/${path}`)
const relative = (path: string) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

const addedDiff = (rel: string, text: string) => {
  const lines = text.replace(/\n$/, '').split('\n')
  return [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n')
}

// A Code source holds at most 10000 characters; a hunk past that, or past the rows the pane has,
// keeps its head and says how much was cut.
export const fit = (diff: string, maxLines: number, maxChars = CODE_MAX_CHARS): string => {
  const lines = diff.split('\n')
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    const note = `… (${lines.length - kept.length - 1} more lines)`
    if (kept.length >= maxLines || size + line.length + 1 + note.length + 1 > maxChars) break
    kept.push(line)
    size += line.length + 1
  }
  const dropped = lines.length - kept.length
  return dropped > 0 ? [...kept, `… (${dropped} more lines)`].join('\n') : diff
}

const git = ($: EngineInterface, args: string[]) => $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })

// An untracked file has no index to diff against: one the tool created shows as added and may be
// deleted; one that was already there (an .env, a gitignored file) shows as added with no revert.
const hunkOf = async ($: EngineInterface, path: string, existed: boolean): Promise<Hunk | undefined> => {
  const rel = relative(path)
  const tracked = await git($, ['ls-files', '--error-unmatch', '--', path])
  if (tracked.exitCode === 0) {
    const run = await git($, ['diff', '--unified=3', '--', path])
    if (run.exitCode !== 0 || !run.stdout.trim()) return undefined
    return { id: nextId++, path, rel, diff: run.stdout.replace(/\n$/, ''), kind: 'tracked' }
  }
  if (tracked.exitCode !== 1) return undefined
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return undefined
  return { id: nextId++, path, rel, diff: addedDiff(rel, text), kind: existed ? 'untracked' : 'new' }
}

const canOpen = () => enabled && interactive && !paneOpen && !closedByPerson && columns !== undefined && columns >= AUTO_OPEN_MIN_COLUMNS

const open = async ($: EngineInterface) => {
  paneOpen = true
  paneDrawn = false
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE }).catch(err => {
    paneOpen = false
    $.ui.log(`diff-review: pane did not open: ${err}`)
  })
}

const track = async ($: EngineInterface, paths: string[], existed: boolean[]) => {
  for (const [i, path] of paths.entries()) {
    const hunk = await hunkOf($, path, existed[i] === true)
    hunks = hunks.filter(h => h.path !== path)
    if (hunk) hunks.unshift(hunk)
  }
  if (canOpen()) await open($)
  $.ui.invalidate('ui.render')
}

const drop = (id: number) => {
  hunks = hunks.filter(h => h.id !== id)
  if (armed?.id === id) disarm()
}

const disarm = () => {
  armed?.timer.cancel()
  armed = undefined
}

// Only the captured hunk is undone, never the file's other uncommitted changes. A file the tool
// created is deleted on a second press within ten seconds: no dialog waits inside the hook, so a
// dropped hook can never leave an rm behind.
const revert = async ($: EngineInterface, hunk: Hunk) => {
  if (hunk.kind === 'new') {
    if (armed?.id !== hunk.id) {
      disarm()
      armed = { id: hunk.id, timer: $.clock.after(ARM_MS, () => { armed = undefined; $.ui.invalidate('ui.render') }) }
      return $.ui.toast(`${hunk.rel} did not exist before this turn: press revert again within 10s to delete it`, { timeoutMs: ARM_MS })
    }
    disarm()
    const rm = await $.process.run(['rm', '--', hunk.path], { timeoutMs: GIT_TIMEOUT_MS })
    if (rm.exitCode !== 0) return $.ui.toast(`diff-review: delete failed: ${rm.stderr.trim()}`, { timeoutMs: 6000 })
    drop(hunk.id)
    return $.ui.toast(`deleted ${hunk.rel}`)
  }
  const run = await $.process.run(['git', 'apply', '-R', '--unidiff-zero', '--'], { stdin: `${hunk.diff}\n`, timeoutMs: GIT_TIMEOUT_MS })
  if (run.exitCode !== 0) return $.ui.toast('hunk no longer applies; nothing changed', { timeoutMs: 6000 })
  drop(hunk.id)
  $.ui.toast(`reverted ${hunk.rel}`)
}

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
let disabled = false
const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === MOD)
  return disabled
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    interactive = e.isInteractive
    cwd = e.cwd
    enabled = (await $.store.get(ENABLED_KEY).catch(() => undefined)) !== false
    await $.command
      .register({
        name: 'diff-review',
        description: 'The diff pane: each edited file\'s hunk with [keep] and [revert] (diff-review)',
        argumentHint: '[open | close | on | off | status]',
        immediate: true,
      })
      .catch(err => $.ui.log(`diff-review: /diff-review not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'diff-review' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'open') {
      closedByPerson = false
      await open($)
      return { text: paneOpen ? `diff-review pane open, ${hunks.length} file(s) this turn` : 'diff-review: pane did not open' }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE_ID }).catch(() => undefined)
      paneOpen = false
      return { text: 'diff-review pane closed' }
    }
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set(ENABLED_KEY, enabled).catch(err => $.ui.log(`diff-review: store write failed: ${err}`))
      if (!enabled && paneOpen) {
        await $.ui.close({ id: PANE_ID }).catch(() => undefined)
        paneOpen = false
      }
      return { text: `diff-review ${arg}` }
    }
    if (arg === '' || arg === 'status') {
      return { text: `diff-review is ${enabled ? 'on' : 'off'}; pane ${paneOpen ? 'open' : 'closed'}; ${hunks.length} file(s) this turn` }
    }
    return { text: `diff-review: "${arg}" is not open, close, on, off, or status` }
  })

  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.surface === 'terminal') columns = e.viewport?.columns ?? columns
    return next(e)
  })

  // An open the plugin made on its own waits undrawn on a narrow terminal; a prompt is the person's
  // input, so an open answering it is placed. Not awaited: a refused open cannot delay the turn.
  on('prompt.submit', ($, e, next) => {
    if (!disabled && paneOpen && !paneDrawn) void $.ui.open({ id: PANE_ID, title: PANE_TITLE }).catch(() => undefined)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (disabled || !hunks.length) return next(e)
    hunks = []
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.close', { id: PANE_ID }, ($, e, next) => {
    paneOpen = false
    if (e.origin.kind === 'person') closedByPerson = true
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const off = disabled || !enabled || e.agentId !== undefined
    const paths = off
      ? []
      : e.tool === 'Bash' ? sedTargets(e.command).map(absolute) : e.tool === 'NotebookEdit' ? [e.notebook_path] : [e.file_path]
    const existed = await Promise.all(paths.map(p => $.fs.exists(p).catch(() => true)))
    const r = await next(e)
    if (!paths.length || r.deny !== undefined || r.isError === true) return r
    try {
      await track($, paths, existed)
    } catch (err) {
      $.ui.log(`diff-review: diff not read: ${err}`)
    }
    return r
  })

  on('ui.press', { plugin: MOD }, async ($, e, next) => {
    if (disabled) return next(e)
    const m = /^(keep|revert):(\d+)$/.exec(e.element)
    const hunk = m ? hunks.find(h => h.id === Number(m[2])) : undefined
    if (!m || !hunk) return next(e)
    if (m[1] === 'keep') drop(hunk.id)
    else await revert($, hunk)
    $.ui.invalidate('ui.render')
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (disabled || e.requestId !== PANE_ID) return next(e)
    paneDrawn = true
    const { Box, Text, Button, Code } = await $.ui.resolve(e)
    const width = Math.max(1, e.props.bodyColumns)
    const rows = Math.max(3, e.props.scroll.bodyRows - 2)
    if (!hunks.length) return <Text dimColor>no edits this turn</Text>
    return (
      <Box flexDirection="column">
        {hunks.map(hunk => (
          <Box key={`hunk:${hunk.id}`} flexDirection="column" marginTop={1}>
            <Box flexDirection="row" columnGap={1}>
              <Text bold wrap="truncate-end">
                {hunk.rel.length > width ? hunk.rel.slice(0, width) : hunk.rel}
              </Text>
              <Button key={`keep:${hunk.id}`} label="keep" onPress={() => undefined} />
              {hunk.kind === 'untracked' ? (
                <Text dimColor>untracked, existed before: no revert</Text>
              ) : (
                <Button key={`revert:${hunk.id}`} label={armed?.id === hunk.id ? 'revert again to delete' : hunk.kind === 'new' ? 'delete' : 'revert'} onPress={() => undefined} />
              )}
            </Box>
            <Code source={fit(hunk.diff, rows)} format="diff" path={hunk.path} />
          </Box>
        ))}
      </Box>
    )
  })
}
