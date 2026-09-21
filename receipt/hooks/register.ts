import type { Register, EngineInterface, ToolGroupCall } from 'claude-code'

// "Verify before claiming." The transcript footer says what the turn actually did (edits, runs,
// curls), a claim made without a run keeps "unverified claim pending" on the next spinner until
// something runs, a destructive Bash never folds into a count line, and an edit-without-run turn
// leaves "run the tests and show the output" as the prompt's ghost text.

const MOD = 'receipt'
const ENABLED_KEY = 'receipt:enabled'
const SUGGESTION = 'run the tests and show the output'
const PENDING = 'unverified claim pending'

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS']
const RUNNERS = ['vitest', 'jest', 'pytest', 'mocha', 'tsc']
const PACKAGE = /^(npm|pnpm|yarn|bun|make)$/
const WRAPPERS = ['npx', 'bunx', 'sudo']
const WRITERS = ['tee', 'cp', 'mv', 'touch']
const QUOTED = '\u0001'
const REDIRECT = /(?<![<>&\w])\d?&?>{1,2}\s*(?!\/dev\/null)[^\s&|;<>]/
const DROP_TABLE = /\bdrop\s+table\b/i
const CLAIM = /\b(deployed|fixed|works now|tests pass|live|verified)\b/i

type Tally = { edits: number; runs: number; curls: number; reads: number; destructive: number }

const fresh = (): Tally => ({ edits: 0, runs: 0, curls: 0, reads: 0, destructive: 0 })
const ran = (t: Tally) => t.runs + t.curls > 0
const nag = (t: Tally | undefined) => t !== undefined && t.edits > 0 && !ran(t)

let tally = fresh()
let last: Tally | undefined
let pending: Tally | undefined
const rows = new Map<string, Tally>()
let claimPending = false
let enabled = true

const commandOf = (input: unknown) => {
  const c = typeof input === 'object' && input !== null ? Reflect.get(input, 'command') : undefined
  return typeof c === 'string' ? c : ''
}

type Kind = { run: boolean; curl: boolean; edit: boolean; destructive: boolean }

// Heredoc bodies and quoted strings are blanked, then each segment is judged by its first word,
// so `echo "npm test"` and `grep curl README.md` are neither a run nor a curl.
const classify = (command: string): Kind => {
  const kind: Kind = { run: false, curl: false, edit: false, destructive: DROP_TABLE.test(command) }
  let text = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\n|$)/g, m => m.slice(0, m.indexOf('\n')))
  text = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, QUOTED)
  for (const segment of text.split(/\n|&&|\|\||[;|]/)) {
    if (REDIRECT.test(segment)) kind.edit = true
    const tokens = segment.replace(/\d?&?>{1,2}\s*[^\s&|;<>]+/g, ' ').trim().split(/\s+/).filter(t => !/^\w+=/.test(t))
    while (tokens.length > 0 && WRAPPERS.includes(tokens[0] ?? '')) tokens.shift()
    const [cmd = '', ...args] = tokens.map(t => t.replace(/^.*\//, ''))
    const sub = args.filter(a => !a.startsWith('-'))[0] ?? ''
    if (RUNNERS.includes(cmd) || ((cmd === 'go' || cmd === 'cargo') && sub === 'test') || (PACKAGE.test(cmd) && /^(test|build)/.test(args[0] === 'run' ? args[1] ?? '' : args[0] ?? '')) || (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'test')) kind.run = true
    if (cmd === 'curl' || cmd === 'wget') kind.curl = true
    if (WRITERS.includes(cmd) || (cmd === 'sed' && args.some(a => a === '-i' || a.startsWith('-i') || a.startsWith('--in-place')))) kind.edit = true
    if ((cmd === 'rm' && args.some(a => /^-\w*r/i.test(a))) || (cmd === 'git' && sub === 'push' && args.some(a => a === '-f' || a === '--force' || a === '--force-with-lease')) || (cmd === 'git' && sub === 'reset' && args.includes('--hard')) || (cmd === 'kubectl' && sub === 'delete')) kind.destructive = true
  }
  return kind
}

const isDestructive = (call: ToolGroupCall) => call.tool === 'Bash' && classify(commandOf(call.input)).destructive

const receipt = (t: Tally) => `${t.edits} edits · ${t.runs} runs${nag(t) ? ' ⚠ no run' : ''}${t.curls > 0 ? ` · ${t.curls} curl` : ''}`

const summary = (t: Tally) => `${t.edits} edits · ${t.runs} runs · ${t.curls} curl · ${t.reads} reads · ${t.destructive} destructive`

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
    enabled = (await $.store.get(ENABLED_KEY).catch(() => undefined)) !== false
    await $.command
      .register({
        name: 'receipt',
        description: 'Show what each turn did on its footer and flag unverified claims (receipt)',
        argumentHint: '[on | off | status]',
        immediate: true,
      })
      .catch(err => $.ui.log(`receipt: /receipt not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'receipt' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set(ENABLED_KEY, enabled).catch(err => $.ui.log(`receipt: store write failed: ${err}`))
      $.ui.invalidate('ui.render')
      return { text: `receipt ${arg}` }
    }
    if (arg === '' || arg === 'status') {
      return { text: `receipt is ${enabled ? 'on' : 'off'}; this turn: ${summary(tally)}; last turn: ${last ? summary(last) : 'none'}; ${claimPending ? PENDING : 'no claim pending'}` }
    }
    return { text: `receipt: "${arg}" is not on, off, or status` }
  })

  on('turn.start', ($, e, next) => {
    if (disabled || !enabled) return next(e)
    tally = fresh()
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (disabled || !enabled) return next(e)
    const r = await next(e)
    if (r.deny !== undefined || r.isError) return r
    if (EDIT_TOOLS.includes(e.tool)) tally.edits++
    else if (READ_TOOLS.includes(e.tool)) tally.reads++
    else if (e.tool === 'Bash') {
      const k = classify(e.command)
      if (k.run) tally.runs++
      if (k.curl) tally.curls++
      if (k.edit) tally.edits++
      if (k.destructive) tally.destructive++
      if (k.run || k.curl) claimPending = false
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (disabled || !enabled || e.agentId !== undefined) return r
    last = { ...tally }
    pending = last
    if (!ran(last) && CLAIM.test(e.answer)) claimPending = true
    if (nag(last)) void $.prompt.suggest({ text: SUGGESTION }).catch(err => $.ui.log(`receipt: suggestion not shown: ${err}`))
    return r
  })

  on('prompt.suggest', ($, e, next) => {
    if (disabled || !enabled || e.origin.kind !== 'suggestion' || !nag(last)) return next(e)
    return next({ ...e, text: SUGGESTION })
  })

  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    if (disabled || !enabled || !claimPending || e.surface !== 'terminal') return next(e)
    const props = e.props.message === null ? { ...e.props, word: `${PENDING} · ${e.props.word}` } : { ...e.props, message: `${PENDING} · ${e.props.message}` }
    return next({ ...e, props })
  })

  on('ui.render', { component: 'TurnDuration' }, ($, e, next) => {
    if (disabled || !enabled || e.surface !== 'terminal') return next(e)
    let row = rows.get(e.requestId)
    if (row === undefined && pending !== undefined) {
      row = pending
      pending = undefined
      rows.set(e.requestId, row)
    }
    if (row === undefined) return next(e)
    return next({ ...e, props: { ...e.props, word: `${receipt(row)} · ${e.props.word}` } })
  })

  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    if (disabled || !enabled || e.props.isExpanded || !e.props.calls.some(isDestructive)) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })
}
