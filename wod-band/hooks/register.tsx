/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

// A tiny Ragtag athlete above the prompt. Every completed turn is a rep, five reps make a round,
// and each round is a different movement; the clock is the session's AMRAP. The sprite is a
// 13x6 pixel grid drawn with half-blocks (one text cell carries two pixels, top as the glyph's
// colour and bottom as its background), so the whole thing is three rows tall.
//
// Frames only advance while a turn is running: a clock ticks at 280ms and invalidates the band,
// and it is cancelled on turn.complete so an idle prompt costs nothing.

const REPS_PER_ROUND = 5
const FRAME_MS = 280
const SHOWN_KEY = 'wod-band:shown'
const LIFETIME_KEY = 'wod-band:lifetime-reps'

const PALETTE: Record<string, string> = {
  h: '#e8b98a', // head / skin
  s: '#e8b98a', // limbs
  r: '#dd3b2a', // ragtag red singlet
  k: '#2b2b2b', // shorts
  b: '#b8b8b8', // bar
  p: '#dd3b2a', // plates
  w: '#f4f1ea', // chalk
}

// prettier-ignore
const THRUSTER = [
  ['......hh.....',
   '.pbbbbbbbbbp.',
   '.....srrs....',
   '......rr.....',
   '......kk.....',
   '.....s..s....'],
  ['.............',
   '......hh.....',
   '.pbbbbbbbbbp.',
   '.....srrs....',
   '....sskkss...',
   '.............'],
  ['......hh.....',
   '.pbbbbbbbbbp.',
   '.....srrs....',
   '......rr.....',
   '......kk.....',
   '.....s..s....'],
  ['.pbbbbbbbbbp.',
   '.....s..s....',
   '......hh.....',
   '.....srrs....',
   '......kk.....',
   '.....s..s....'],
]
// prettier-ignore
const BURPEE = [
  ['......hh.....',
   '.....srrs....',
   '......rr.....',
   '......kk.....',
   '.....s..s....',
   '.............'],
  ['.............',
   '.............',
   '.............',
   '.hh..........',
   '.srrrrkkss...',
   '.s.......s...'],
  ['.............',
   '......hh.....',
   '.....srrs....',
   '....sskkss...',
   '.............',
   '.............'],
  ['.....s..s....',
   '......hh.....',
   '.....srrs....',
   '......kk.....',
   '.....s..s....',
   '.............'],
]
// prettier-ignore
const PULLUP = [
  ['.bbbbbbbbbbb.',
   '.....s..s....',
   '.....s..s....',
   '......hh.....',
   '.....srrs....',
   '......kk.....'],
  ['.bbbbbbbbbbb.',
   '.....s..s....',
   '......hh.....',
   '.....srrs....',
   '......kk.....',
   '.............'],
  ['......hh.....',
   '.bbbsrrsbbb..',
   '......rr.....',
   '......kk.....',
   '.....s..s....',
   '.............'],
  ['.bbbbbbbbbbb.',
   '.....s..s....',
   '......hh.....',
   '.....srrs....',
   '......kk.....',
   '.............'],
]
// prettier-ignore
const REST = [
  ['......hh.....',
   '.....srrs....',
   '......rr.....',
   '......kk.....',
   '.....s..s....',
   '.pbbbbbbbbbp.'],
]
// prettier-ignore
const CHALK = [
  ['......hh.....',
   '....wsrrsw...',
   '......rr.....',
   '......kk.....',
   '.....s..s....',
   '.pbbbbbbbbbp.'],
]

const MOVEMENTS = [
  { name: 'thrusters', frames: THRUSTER },
  { name: 'burpees', frames: BURPEE },
  { name: 'pull-ups', frames: PULLUP },
]

let shown = true
let reps = 0
let lifetime = 0
let startedAt = Date.now()
let frame = 0
let running = false
let flashUntil = 0
let tick: { cancel: () => void } | undefined

const round = () => Math.floor(reps / REPS_PER_ROUND)
const movement = () => MOVEMENTS[round() % MOVEMENTS.length]!

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

const currentFrames = () => {
  if (running) return movement().frames
  if (Date.now() < flashUntil) return CHALK
  return REST
}

async function finish($: EngineInterface, counts: boolean) {
  tick?.cancel()
  tick = undefined
  running = false
  if (counts) {
    reps += 1
    lifetime += 1
    flashUntil = Date.now() + 1500
    await $.store.set(LIFETIME_KEY, lifetime).catch(() => undefined)
    if (reps % REPS_PER_ROUND === 0) {
      $.ui.toast(`round ${round()} done · now ${movement().name}`, { timeoutMs: 4000 })
    }
  }
  $.ui.invalidate('ui.render')
}

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'wod-band'
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
    const stored = await $.store.get(LIFETIME_KEY).catch(() => undefined)
    if (typeof stored === 'number') lifetime = stored
    startedAt = Date.now()
    await $.command
      .register({
        name: 'wod',
        description: 'The pixel athlete above the prompt: reps per turn, AMRAP clock (wod-band)',
        argumentHint: '[on | off | reset]',
        immediate: true,
      })
      .catch((err) => $.ui.log(`wod-band: /wod not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'wod' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      shown = false
      await $.store.set(SHOWN_KEY, false).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'wod band off. rest day.' }
    }
    if (arg === 'reset') {
      reps = 0
      startedAt = Date.now()
      $.ui.invalidate('ui.render')
      return { text: '3, 2, 1... clock reset, new AMRAP' }
    }
    if (arg === 'on' || arg === '') {
      shown = true
      await $.store.set(SHOWN_KEY, true).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'wod band on. every turn is a rep.' }
    }
    return { text: `wod: no such argument "${arg}" — use on, off or reset` }
  })

  on('turn.start', async ($, e, next) => {
    if (disabled) return next(e)
    running = true
    frame = 0
    tick?.cancel()
    tick = $.clock.every(FRAME_MS, () => {
      frame = (frame + 1) % movement().frames.length
      $.ui.invalidate('ui.render')
    })
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    await finish($, true)
    return r
  })

  on('turn.abort', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    await finish($, false)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (!shown || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    try {
      const { Box, Text } = await $.ui.resolve(e)
      const rest = await next(e)
      const frames = currentFrames()
      const grid = frames[frame % frames.length]!
      const rows = [0, 2, 4].map((y) => {
        const top = grid[y]!
        const bot = grid[y + 1]!
        const cells = [...top].map((t, x) => {
          const b = bot[x] ?? '.'
          const tc = PALETTE[t]
          const bc = PALETTE[b]
          if (tc && bc) return <Text key={`${x}`} color={tc} backgroundColor={bc}>{'▀'}</Text>
          if (tc) return <Text key={`${x}`} color={tc}>{'▀'}</Text>
          if (bc) return <Text key={`${x}`} color={bc}>{'▄'}</Text>
          return <Text key={`${x}`}>{' '}</Text>
        })
        return <Text key={`${y}`}>{cells}</Text>
      })
      const inRound = reps % REPS_PER_ROUND
      const flashing = !running && Date.now() < flashUntil
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Box flexDirection="column">{rows}</Box>
            <Box flexDirection="column">
              <Text>
                <Text bold color="#dd3b2a">AMRAP</Text>
                <Text dimColor>{` ${clock(Date.now() - startedAt)}`}</Text>
              </Text>
              <Text>
                <Text dimColor>round </Text>
                <Text bold>{`${round() + 1}`}</Text>
                <Text dimColor>{` · ${movement().name} `}</Text>
                <Text bold>{`${inRound}/${REPS_PER_ROUND}`}</Text>
                {running ? <Text color="yellow"> · working</Text> : null}
                {flashing ? <Text color="green"> · rep!</Text> : null}
              </Text>
              <Text dimColor>{`${reps} reps this session · ${lifetime} all-time`}</Text>
            </Box>
          </Box>
          {rest}
        </Box>
      )
    } catch (err) {
      $.ui.log(`wod-band: render failed: ${err}`)
      return next(e)
    }
  })
}
