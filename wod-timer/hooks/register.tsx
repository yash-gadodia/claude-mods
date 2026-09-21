/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

// A gym timer for each turn. Submitting a prompt starts "3 · 2 · 1 · GO" (450ms a beat) in the
// band and in the spinner's word, then the clock runs a second at a time from the turn's first
// model request until the turn lands. The split goes on the band beside the session's average and
// longest, and the "Cooked for 1m 5s" line becomes the whiteboard: turn number, split, AMRAP (the
// session's running total) and PR when this is the fastest turn over 5s so far. With voice on, a
// turn over a minute is read aloud from turn.complete. Tickers are started only by prompt.submit
// and turn.start and stopped by turn.complete and turn.abort, never by a render.

const BEAT_MS = 450
const MIN_REDRAW_MS = 100
const SHOWN_KEY = 'wod-timer:shown'
const VOICE_KEY = 'wod-timer:voice'
const PR_MIN_MS = 5_000
const SPEAK_MIN_MS = 60_000

let shown = true
let voice = false
let phase: 'idle' | 'count' | 'run' = 'idle'
let beat = 0
let startedAt = 0
let requestAt: number | undefined
let last: number | undefined
type Row = { n: number; split: number; total: number; pr: boolean }
let pending: Row | undefined
let splits: number[] = []
let best: number | undefined
const rows = new Map<string, Row>()
let lastDraw = -Infinity
let tick: { cancel: () => void } | undefined

const COUNT = ['3', '2', '1', 'GO']

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

const stop = () => {
  tick?.cancel()
  tick = undefined
}

async function redraw($: EngineInterface) {
  const now = await $.clock.now()
  if (now - lastDraw < MIN_REDRAW_MS) return
  lastDraw = now
  $.ui.invalidate('ui.render')
}

const origin = () => requestAt ?? startedAt

function startRun($: EngineInterface) {
  phase = 'run'
  stop()
  tick = $.clock.every(1000, () => void redraw($))
  void redraw($)
}

async function land($: EngineInterface, counts: boolean) {
  stop()
  let split: number | undefined
  if (phase !== 'idle' && counts) {
    split = (await $.clock.now()) - origin()
    last = split
    splits.push(split)
    const pr = split > PR_MIN_MS && (best === undefined || split < best)
    if (pr) best = split
    pending = { n: splits.length, split, total: splits.reduce((a, b) => a + b, 0), pr }
  }
  phase = 'idle'
  requestAt = undefined
  await redraw($)
  return split
}

const whiteboard = (r: Row) => `turn ${r.n} · ${clock(r.split)} · AMRAP ${clock(r.total)}${r.pr ? ' · PR' : ''}`

const speak = ($: EngineInterface, ms: number) => {
  const m = Math.floor(ms / 60_000)
  const s = Math.floor(ms / 1000) % 60
  const text = `${m} minute${m === 1 ? '' : 's'}${s ? ` ${s}` : ''}, done`
  Promise.resolve()
    .then(() => $.audio.speak(text))
    .catch((err) => $.ui.log(`wod-timer: voice failed: ${err}`))
}

const tail = () => {
  const avg = splits.reduce((a, b) => a + b, 0) / splits.length
  const longest = Math.max(...splits)
  return [` · avg ${clock(avg)}`, ` · longest ${clock(longest)}`, ` · ${splits.length} turns`]
}

const summary = () => tail().map((t) => t.slice(3)).join(' · ')

// Sheds parts from the end until head plus the rest fits the width.
export const fit = (width: number, head: string, parts: string[]) => {
  const kept = [...parts]
  while (kept.length > 0 && head.length + kept.join('').length > width) kept.pop()
  return kept.join('')
}

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'wod-timer'
let disabled = false
const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === MOD)
  return disabled
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    if ((await $.store.get(SHOWN_KEY).catch(() => undefined)) === false) shown = false
    if ((await $.store.get(VOICE_KEY).catch(() => undefined)) === true) voice = true
    await $.command
      .register({
        name: 'wod-timer',
        description: '3-2-1-GO on submit, a running clock per turn and a whiteboard split (wod-timer)',
        argumentHint: '[on | off | voice on | voice off]',
        immediate: true,
      })
      .catch((err) => $.ui.log(`wod-timer: /wod-timer not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'wod-timer' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    if (arg === 'voice on' || arg === 'voice off') {
      voice = arg === 'voice on'
      await $.store.set(VOICE_KEY, voice).catch(() => undefined)
      return { text: `wod timer voice ${voice ? 'on: turns over a minute are read aloud' : 'off'}` }
    }
    if (arg === 'off') {
      shown = false
      stop()
      await $.store.set(SHOWN_KEY, false).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'wod timer off' }
    }
    if (arg === 'on' || arg === '') {
      shown = true
      await $.store.set(SHOWN_KEY, true).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'wod timer on' }
    }
    return { text: `wod-timer: no such argument "${arg}" — use on, off, voice on or voice off` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (disabled || !shown || e.turnId !== undefined || e.text.startsWith('/')) return next(e)
    startedAt = await $.clock.now()
    requestAt = undefined
    phase = 'count'
    beat = 0
    stop()
    tick = $.clock.every(BEAT_MS, () => {
      beat += 1
      if (beat >= COUNT.length) {
        if (phase === 'count') startRun($)
        return
      }
      void redraw($)
    })
    await redraw($)
    const r = await next(e)
    if (r.drop !== undefined) {
      stop()
      phase = 'idle'
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (disabled) return next(e)
    // A turn the timer did not see submitted (a plugin's own prompt, a resumed session) still
    // gets a clock, but never a countdown mid-run.
    if (shown && phase === 'idle') {
      startedAt = await $.clock.now()
      requestAt = undefined
      startRun($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!disabled && e.agentId === undefined && requestAt === undefined) requestAt = await $.clock.now()
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    if (e.agentId === undefined) {
      const split = await land($, true)
      if (voice && split !== undefined && split > SPEAK_MIN_MS) speak($, split)
    }
    return r
  })

  on('turn.abort', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    await land($, false)
    return r
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (disabled || !shown || e.surface !== 'terminal' || phase !== 'count') return next(e)
    return next({ ...e, props: { ...e.props, word: COUNT[Math.min(beat, COUNT.length - 1)]! } })
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (disabled || !shown || e.surface !== 'terminal') return next(e)
    let row = rows.get(e.requestId)
    if (row === undefined && pending !== undefined) {
      row = pending
      pending = undefined
      rows.set(e.requestId, row)
    }
    if (row === undefined) return next(e)
    return next({ ...e, props: { ...e.props, word: `${whiteboard(row)} · ${e.props.word}` } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (!shown || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    try {
      const { Box, Text } = await $.ui.resolve(e)
      const rest = await next(e)
      const now = await $.clock.now()
      const width = e.props.bodyColumns ?? 80
      let line
      if (phase === 'count') {
        const word = COUNT[Math.min(beat, COUNT.length - 1)]!
        const colour = word === 'GO' ? 'green' : word === '1' ? 'yellow' : '#dd3b2a'
        line = (
          <Text wrap="truncate-end">
            <Text dimColor>timer  </Text>
            <Text dimColor>{COUNT.slice(0, beat).map((w) => `${w} · `).join('')}</Text>
            <Text bold color={colour}>{word}</Text>
          </Text>
        )
      } else if (phase === 'run') {
        const t = clock(now - origin())
        line = (
          <Text wrap="truncate-end">
            <Text dimColor>timer  </Text>
            <Text bold color="green">{t}</Text>
            <Text dimColor>{fit(width, `timer  ${t}`, [' running'])}</Text>
          </Text>
        )
      } else if (last !== undefined) {
        const head = `timer  split ${clock(last)}`
        line = (
          <Text wrap="truncate-end">
            <Text dimColor>timer  split </Text>
            <Text bold>{clock(last)}</Text>
            <Text dimColor>{fit(width, head, tail())}</Text>
          </Text>
        )
      } else {
        line = <Text dimColor wrap="truncate-end">timer  ready · 3, 2, 1 on your next prompt</Text>
      }
      return (
        <Box flexDirection="column">
          {line}
          {rest}
        </Box>
      )
    } catch (err) {
      $.ui.log(`wod-timer: render failed: ${err}`)
      return next(e)
    }
  })
}
