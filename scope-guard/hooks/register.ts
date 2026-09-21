import type { Register, EngineInterface, SessionMessage, ToolCheckInput, ToolCheckResult } from 'claude-code'

// Silent scope drift is the expensive failure: the one-line fix that touched nine files.
// This mod counts the distinct files a single turn writes to, and at the threshold it stops
// and asks for the goal to be restated. Answering "Continue" raises the bar for that turn only.

const THRESHOLD_KEY = 'scope-guard:threshold'
const JUDGE_KEY = 'scope-guard:judge'
const DEFAULT_THRESHOLD = 4
// tool.check's matcher takes an any-of list, so the scanner records these three, not every tool.
const EDITING_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const HUMAN_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']

let threshold = DEFAULT_THRESHOLD
let interactive = false
let touched = new Set<string>()
let ceiling = DEFAULT_THRESHOLD
let paused = false
let goal = ''
let turnId: string | undefined
let aborting: string | undefined

const pathOf = (tool: string, input: unknown): string | undefined => {
  const i = (input ?? {}) as Record<string, unknown>
  const v = tool === 'NotebookEdit' ? i.notebook_path : i.file_path
  return typeof v === 'string' ? v : undefined
}

const editOf = (input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const v = i.new_string ?? i.content ?? i.new_source
  return typeof v === 'string' ? v.slice(0, 1500) : ''
}

const short = (path: string, root: string) => (path.startsWith(root) ? path.slice(root.length + 1) : path)

// In bypass mode the harness edits through Bash, so a Bash call is read for the files it writes:
// sed -i, a redirection, tee, cp/mv's destination, touch. Heredoc bodies and quoted strings are
// blanked first (a quoted string becomes one opaque token) so `echo "> file"` names nothing.
const QUOTED = '\u0001'
const SCRATCH = ['/tmp/', '/private/tmp/', '/dev/']
const FLAG = (t: string) => t.startsWith('-') && t !== '-'
const WRITERS: Record<string, (args: string[]) => string[]> = {
  sed: args => {
    if (!args.some(a => a === '-i' || a.startsWith('-i') || a.startsWith('--in-place'))) return []
    const rest = args.filter(a => !FLAG(a))
    const scripted = args.some(a => a === '-e' || a === '--expression' || a.startsWith('--expression=')) || rest.includes(QUOTED)
    return (scripted ? rest : rest.slice(1)).filter(a => a !== QUOTED)
  },
  tee: args => args.filter(a => !FLAG(a)),
  touch: args => args.filter(a => !FLAG(a)),
  cp: args => args.filter(a => !FLAG(a)).slice(-1),
  mv: args => args.filter(a => !FLAG(a)).slice(-1),
}

export const bashTargets = (command: string, root: string): string[] => {
  let text = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\n|$)/g, m => m.slice(0, m.indexOf('\n')))
  text = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, QUOTED)
  const found: string[] = []
  for (const segment of text.split(/\n|&&|\|\||[;|]/)) {
    for (const m of segment.matchAll(/(?<![<>&\w])\d?&?>{1,2}\s*([^\s&|;<>]+)/g)) found.push(m[1] ?? '')
    const tokens = segment.replace(/\d?&?>{1,2}\s*[^\s&|;<>]+/g, ' ').trim().split(/\s+/)
    const at = tokens.findIndex(t => !/^\w+=/.test(t) && t !== 'sudo')
    const cmd = tokens[at]?.replace(/^.*\//, '')
    if (cmd && WRITERS[cmd]) found.push(...WRITERS[cmd](tokens.slice(at + 1)))
  }
  const paths = found
    .filter(t => t !== '' && t !== '-' && !t.includes(QUOTED) && !t.includes('$') && !t.includes('*'))
    .map(t => (t.startsWith('/') ? t : `${root}/${t.replace(/^\.\//, '')}`))
    .filter(p => !SCRATCH.some(s => p.startsWith(s)))
  return [...new Set(paths)]
}

// The threshold is a rule the model should know before it plans, not a surprise it meets at the
// fourth edit. It goes into the first user message's context under this name, replaced in place
// rather than accumulated, and refreshed whenever the threshold or a stop changes it.
const CONTEXT_BLOCK = 'scopeGuard'
let stops = 0

// At the threshold, Haiku reads the goal, the files so far and the edit itself: an edit plainly
// inside the goal is let through, and the turn's bar rises by one, once. Anything else (a no,
// a malformed reply, a failed call) falls through to the ask or the deny, so the judge can only
// ever soften the guard by one file.
const JUDGE_MODEL = 'claude-haiku-4-5-20251001'
const JUDGE_SYSTEM =
  'You judge whether one file edit stays within the goal a user stated. Reply with one JSON object and nothing else: {"ok": true} or {"ok": false, "reason": "..."}.'
let judge = true
let judged = false
let judgeNote = ''

const verdictOf = (reply: string): { ok: boolean; reason: string } | undefined => {
  const json = reply.match(/\{[\s\S]*\}/)
  if (!json) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json[0])
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed) || typeof parsed.ok !== 'boolean') return undefined
  return { ok: parsed.ok, reason: 'reason' in parsed && typeof parsed.reason === 'string' ? parsed.reason : '' }
}

const askJudge = async ($: EngineInterface, files: string[], nextFile: string, edit: string) => {
  const prompt = `Is this edit within the stated goal?\n${JSON.stringify({ goal, filesTouchedSoFar: files, nextFile, edit })}`
  const reply = await $.model.complete({ model: JUDGE_MODEL, system: JUDGE_SYSTEM, prompt, maxTokens: 200 })
  return verdictOf(reply)
}

// After a resume or a reload the module's memory is empty but the transcript is not: the goal is
// the first human prompt in it, and the files of the turn in flight are the editing calls since
// the last human prompt.
const human = (m: SessionMessage) => m.role === 'user' && !m.toolResults?.length && m.text.trim() !== ''

const rebuild = async ($: EngineInterface) => {
  const messages = await $.session.messages()
  const prompts = messages.filter(human)
  if (!goal) goal = prompts[0]?.text ?? ''
  const last = prompts.at(-1)
  const since = last ? messages.slice(messages.indexOf(last) + 1) : []
  touched = new Set(
    since
      .flatMap(m => m.toolUses)
      .filter(u => EDITING_TOOLS.includes(u.tool))
      .map(u => pathOf(u.tool, u.input))
      .filter((p): p is string => p !== undefined),
  )
}

const RESTATE =
  'Do not edit anything else. Restate: (1) the goal in one sentence, (2) the branch or environment, (3) the files you expect to touch, (4) what done looks like. Then wait.'

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'scope-guard'
let disabled = false
const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === MOD)
  return disabled
}

const decide = async ($: EngineInterface, e: ToolCheckInput, next: (e: ToolCheckInput) => Promise<ToolCheckResult>, paths: string[], edit: string) => {
  if (disabled || paused || e.tool_use_id === undefined) return next(e)
  const fresh = paths.filter(p => !touched.has(p))
  if (fresh.length === 0) return next(e)

  const below = next(e)
  if (touched.size + fresh.length <= ceiling) {
    const r = await below
    if (r.decision !== 'deny') for (const p of fresh) touched.add(p)
    $.ui.status(touched.size >= ceiling ? `scope: ${touched.size}/${ceiling} files` : undefined)
    return r
  }

  const root = await $.session.cwd()
  const files = [...touched].map(p => short(p, root))
  const file = fresh.map(p => short(p, root)).join(', ')
  const admit = () => {
    for (const p of fresh) touched.add(p)
    return below
  }

  if (judge && !judged) {
    judged = true
    $.ui.status(`scope: judging ${file}`)
    const verdict = await askJudge($, files, file, edit).catch(err => {
      $.ui.log(`scope-guard: judge failed: ${err}`)
      return undefined
    })
    if (verdict?.ok) {
      ceiling = touched.size + fresh.length
      judgeNote = `A Haiku judge found the edit to ${file} within the goal and raised this turn's threshold to ${ceiling}, once.`
      $.ui.invalidate('prompt.context')
      $.ui.status(`scope: ${touched.size + fresh.length}/${ceiling} files (judge passed ${file})`)
      return admit()
    }
    $.ui.status(undefined)
    if (verdict && !verdict.ok) $.ui.log(`scope-guard: judge on ${file}: ${verdict.reason || 'not within the goal'}`)
  }

  const listing = files.map(f => `  ${f}`).join('\n')
  const stop = (): ToolCheckResult => {
    stops++
    $.ui.invalidate('prompt.context')
    return {
      decision: 'deny',
      reason: [
        `scope-guard stopped this edit: the turn has already touched ${touched.size} files (${files.join(', ')}) and ${file} would take it past the threshold of ${ceiling}.`,
        RESTATE,
      ].join('\n'),
    }
  }

  if (!interactive) {
    // A refusal alone is answered with another tool; ending the turn is what makes the model
    // stop and restate. The stop waits so the refusal lands in the transcript first.
    const running = turnId
    if (running !== undefined && aborting !== running) {
      aborting = running
      $.clock.after(250, () => void $.turn.abort({ turnId: running }).catch(err => $.ui.log(`scope-guard: abort failed: ${err}`)))
    }
    return stop()
  }

  const question = `This turn has already edited ${touched.size} files and is about to edit ${file}.\n${listing}\n\nRestate the goal before going further?`
  const answer = await $.ui
    .ask(question, {
      header: 'scope-guard',
      options: [`Stop — I'll restate the goal`, 'Continue, this is in scope', 'Off for this session'],
    })
    .catch(() => 'Continue, this is in scope')

  if (answer === 'Off for this session') {
    paused = true
    return admit()
  }
  if (answer.startsWith('Stop')) return stop()
  // in scope: let this turn run to double the threshold before asking again
  ceiling = ceiling * 2
  return admit()
}

const failClosed = ($: EngineInterface, e: ToolCheckInput, next: { error: { kind: string; message?: string } }): ToolCheckResult => ({
  decision: 'deny',
  reason: [
    `scope-guard errored (${next.error.kind}${next.error.message ? `: ${next.error.message}` : ''}) and denied this edit rather than let it through unchecked.`,
    'To disable the guard: /scope off for this session, or CLAUDE_MODS_DISABLE=scope-guard in the environment.',
  ].join('\n'),
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    interactive = e.isInteractive
    const saved = Number(await $.store.get(THRESHOLD_KEY).catch(() => undefined))
    if (Number.isFinite(saved) && saved > 0) threshold = saved
    ceiling = threshold
    judge = (await $.store.get(JUDGE_KEY).catch(() => undefined)) !== false
    await rebuild($).catch(err => $.ui.log(`scope-guard: transcript not read: ${err}`))
    await $.command
      .register({
        name: 'scope',
        description: 'Files this turn has edited, and the threshold that stops for a restated goal (scope-guard)',
        argumentHint: '[<number> | off | judge on|off | status]',
        immediate: true,
      })
      .catch(err => $.ui.log(`scope-guard: /scope not registered: ${err}`))
    return r
  })

  on('prompt.submit', ($, e, next) => {
    if (!disabled && !goal && HUMAN_ORIGINS.includes(e.origin.kind) && !e.text.startsWith('/')) goal = e.text
    return next(e)
  })

  on('command.run', { command: 'scope' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const root = await $.session.cwd()
    const listing = touched.size
      ? `\nthis turn has edited ${touched.size} file(s):\n${[...touched].map(p => `  ${short(p, root)}`).join('\n')}`
      : '\nthis turn has edited nothing yet'
    if (arg === '' || arg === 'status') {
      const line = `scope-guard stops at ${paused ? 'never (off)' : `${threshold} files`}; judge ${judge ? 'on' : 'off'}`
      return { text: `${line}${goal ? `\ngoal: ${goal}` : ''}${listing}` }
    }
    if (arg === 'off') {
      paused = true
      return { text: 'scope-guard off for this session' }
    }
    if (arg === 'judge on' || arg === 'judge off') {
      judge = arg === 'judge on'
      await $.store.set(JUDGE_KEY, judge).catch(err => $.ui.log(`scope-guard: store write failed: ${err}`))
      return { text: `scope-guard judge ${judge ? 'on: Haiku may let one in-scope edit past the threshold per turn' : 'off'}` }
    }
    const n = Number(arg)
    if (!Number.isFinite(n) || n < 1) return { text: `scope: "${arg}" is not a file count, off, judge on|off, or status` }
    threshold = Math.floor(n)
    ceiling = threshold
    paused = false
    await $.store.set(THRESHOLD_KEY, threshold).catch(err => $.ui.log(`scope-guard: store write failed: ${err}`))
    $.ui.invalidate('prompt.context')
    return { text: `scope-guard will stop at ${threshold} files in one turn` }
  })

  on('prompt.context', async ($, e, next) => {
    const below = await next(e)
    if (disabled || paused) return below
    const text = [
      `scope-guard stops a turn that edits more than ${threshold} distinct files.`,
      'Before a change that will touch more than that, state in one sentence: the goal, the branch or',
      'environment, the files you expect to touch, and what done looks like — then get agreement.',
      ...(stops ? [`This session has already been stopped ${stops === 1 ? 'once' : `${stops} times`} for scope.`] : []),
      ...(judgeNote ? [judgeNote] : []),
    ].join('\n')
    return { ...below, blocks: [...below.blocks.filter(b => b.name !== CONTEXT_BLOCK), { name: CONTEXT_BLOCK, text }] }
  })

  on('turn.start', async ($, e, next) => {
    if (disabled) return next(e)
    touched = new Set()
    ceiling = threshold
    judged = false
    judgeNote = ''
    turnId = e.turnId
    return next(e)
  })

  on('tool.check', { tool: EDITING_TOOLS }, ($, e, next) => {
    const path = pathOf(e.tool, e.input)
    return decide($, e, next, path ? [path] : [], editOf(e.input))
  }).catch(failClosed)

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = ((e.input ?? {}) as Record<string, unknown>).command
    if (typeof command !== 'string' || disabled || paused || e.tool_use_id === undefined) return next(e)
    const paths = bashTargets(command, await $.session.cwd())
    return decide($, e, next, paths, command.slice(0, 1500))
  }).catch(failClosed)
}
