import type { Register, ToolCallInput, EngineInterface } from 'claude-code'

// Silent scope drift is the expensive failure: the one-line fix that touched nine files.
// This mod counts the distinct files a single turn writes to, and at the threshold it stops
// and asks for the goal to be restated. Answering "Continue" raises the bar for that turn only.

const THRESHOLD_KEY = 'scope-guard:threshold'
const DEFAULT_THRESHOLD = 4

let threshold = DEFAULT_THRESHOLD
let interactive = false
let touched = new Set<string>()
let ceiling = DEFAULT_THRESHOLD
let paused = false

// The matcher wants one literal tool, so the three editing tools are told apart here instead.
const pathOf = (e: ToolCallInput): string | undefined =>
  e.tool === 'NotebookEdit' ? e.notebook_path : e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : undefined

const short = (path: string, root: string) => (path.startsWith(root) ? path.slice(root.length + 1) : path)

// The threshold is a rule the model should know before it plans, not a surprise it meets at the
// fourth edit. It goes into the first user message's context under this name, replaced in place
// rather than accumulated, and refreshed whenever the threshold or a stop changes it.
const CONTEXT_BLOCK = 'scopeGuard'
let stops = 0

// Past the threshold in a non-interactive session there is nobody to ask, so the objection is
// appended to the tool result instead. Unthrottled, that paragraph repeats on every subsequent
// edit of the same turn and says nothing new each time.
const ADVISORY_COOLDOWN_MS = 5 * 60 * 1000
const advised = new Map<string, number>()

const digest = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `${h}`
}

const fresh = async ($: EngineInterface, text: string): Promise<boolean> => {
  const key = digest(text)
  const now = await $.clock.now()
  const seen = advised.get(key)
  if (seen !== undefined && now - seen < ADVISORY_COOLDOWN_MS) return false
  advised.set(key, now)
  return true
}

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    interactive = e.isInteractive
    const saved = Number(await $.store.get(THRESHOLD_KEY).catch(() => undefined))
    if (Number.isFinite(saved) && saved > 0) threshold = saved
    ceiling = threshold
    await $.command
      .register({
        name: 'scope',
        description: 'Files this turn has edited, and the threshold that stops for a restated goal (scope-guard)',
        argumentHint: '[<number> | off | status]',
        immediate: true,
      })
      .catch(err => $.ui.log(`scope-guard: /scope not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'scope' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const root = await $.session.cwd()
    const listing = touched.size
      ? `\nthis turn has edited ${touched.size} file(s):\n${[...touched].map(p => `  ${short(p, root)}`).join('\n')}`
      : '\nthis turn has edited nothing yet'
    if (arg === '' || arg === 'status') {
      return { text: `scope-guard stops at ${paused ? 'never (off)' : `${threshold} files`}${listing}` }
    }
    if (arg === 'off') {
      paused = true
      return { text: 'scope-guard off for this session' }
    }
    const n = Number(arg)
    if (!Number.isFinite(n) || n < 1) return { text: `scope: "${arg}" is not a file count, off, or status` }
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
    ].join('\n')
    return { ...below, blocks: [...below.blocks.filter(b => b.name !== CONTEXT_BLOCK), { name: CONTEXT_BLOCK, text }] }
  })

  on('turn.start', async ($, e, next) => {
    if (disabled) return next(e)
    touched = new Set()
    ceiling = threshold
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (disabled) return next(e)
    const path = pathOf(e)
    if (!path || paused || touched.has(path)) {
      if (path) touched.add(path)
      return next(e)
    }

    const next_count = touched.size + 1
    if (next_count <= ceiling) {
      touched.add(path)
      $.ui.status(next_count >= ceiling ? `scope: ${next_count}/${ceiling} files` : undefined)
      return next(e)
    }

    const root = await $.session.cwd()
    const listing = [...touched].map(p => `  ${short(p, root)}`).join('\n')
    const question = `This turn has already edited ${touched.size} files and is about to edit ${short(path, root)}.\n${listing}\n\nRestate the goal before going further?`

    if (!interactive) {
      touched.add(path)
      const r = await next(e)
      if ('deny' in r) return r
      const lines = [
        `scope-guard: this turn has now edited ${next_count} distinct files, past the threshold of ${ceiling}.`,
        'Before editing anything more, state the goal in one sentence and the files you expect to touch.',
      ]
      if (!(await fresh($, lines.join('\n')))) return r
      return { ...r, context: [...(r.context ?? []), ...lines] }
    }

    const answer = await $.ui
      .ask(question, {
        header: 'scope-guard',
        options: [`Stop — I'll restate the goal`, 'Continue, this is in scope', 'Off for this session'],
      })
      .catch(() => 'Continue, this is in scope')

    if (answer === 'Off for this session') {
      paused = true
      touched.add(path)
      return next(e)
    }
    if (answer.startsWith('Stop')) {
      stops++
      $.ui.invalidate('prompt.context')
      return {
        deny: [
          `scope-guard stopped this edit: the turn has already touched ${touched.size} files and the user wants the goal restated.`,
          'Do not edit anything else. Restate: (1) the goal in one sentence, (2) the branch or environment, (3) the files you expect to touch, (4) what done looks like. Then wait.',
        ].join('\n'),
      }
    }
    // in scope: let this turn run to double the threshold before asking again
    ceiling = ceiling * 2
    touched.add(path)
    return next(e)
  })
}
