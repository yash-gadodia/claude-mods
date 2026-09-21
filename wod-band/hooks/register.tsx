/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

// A tiny Ragtag athlete above the prompt. Every completed tool call is a rep of the movement that
// tool is: an edit is a thruster, a shell command a burpee, a read or search a pull-up. Five reps
// make a round and the clock is the session's AMRAP. The sprite is a 13x6 pixel grid drawn with
// half-blocks (one cell carries two pixels, top as the glyph's colour and bottom as its background)
// into one Raster, three rows tall. Frames are encoded once at load and repainted in place with
// $.ui.blit; the caption is only redrawn when its text changes.

const REPS_PER_ROUND = 5
const FRAME_MS = 280
const CHALK_TICKS = 5
const NOREP_TICKS = 6
const REST_TICKS = 150
const SHOWN_KEY = 'wod-band:shown'
const LIFETIME_KEY = 'wod-band:lifetime-reps'
const RASTER_KEY = 'wod'
const COLUMNS = 13
const ROWS = 3
const DEFAULT = 0x01000000

const PALETTE: Record<string, number> = {
  h: 0xe8b98a, // head / skin
  s: 0xe8b98a, // limbs
  r: 0xdd3b2a, // ragtag red singlet
  k: 0x2b2b2b, // shorts
  b: 0xb8b8b8, // bar
  p: 0xdd3b2a, // plates
  w: 0xf4f1ea, // chalk
  x: 0xe05252, // no rep
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
// prettier-ignore
const NOREP = [
  ['.x.........x.',
   '..x..hh...x..',
   '...xsrrsx....',
   '....x.rrx....',
   '...x..kk.x...',
   '..x..s..s.x..'],
]

const HALF_TOP = 0x2580
const HALF_BOTTOM = 0x2584
const SPACE = 0x20

export function cellsFor(grid: readonly string[]): string {
  const words = new Uint32Array(COLUMNS * ROWS * 3)
  for (let y = 0; y < ROWS; y++) {
    const top = grid[y * 2] ?? ''
    const bot = grid[y * 2 + 1] ?? ''
    for (let x = 0; x < COLUMNS; x++) {
      const i = (y * COLUMNS + x) * 3
      const tc = PALETTE[top[x] ?? '.']
      const bc = PALETTE[bot[x] ?? '.']
      if (tc !== undefined) {
        words[i] = HALF_TOP
        words[i + 1] = tc
        words[i + 2] = bc ?? DEFAULT
      } else if (bc !== undefined) {
        words[i] = HALF_BOTTOM
        words[i + 1] = bc
        words[i + 2] = DEFAULT
      } else {
        words[i] = SPACE
        words[i + 1] = DEFAULT
        words[i + 2] = DEFAULT
      }
    }
  }
  const bytes = new Uint8Array(words.buffer) as unknown as { toBase64: () => string }
  return bytes.toBase64()
}

type Movement = 'thrusters' | 'burpees' | 'pull-ups'
const MOVEMENTS: Movement[] = ['thrusters', 'burpees', 'pull-ups']
const FRAMES: Record<Movement, string[]> = {
  thrusters: THRUSTER.map(cellsFor),
  burpees: BURPEE.map(cellsFor),
  'pull-ups': PULLUP.map(cellsFor),
}
export const REST_CELLS = cellsFor(REST[0]!)
export const CHALK_CELLS = cellsFor(CHALK[0]!)
export const NOREP_CELLS = cellsFor(NOREP[0]!)

const TOOL_MOVEMENT: Record<string, Movement> = {
  Edit: 'thrusters',
  Write: 'thrusters',
  MultiEdit: 'thrusters',
  NotebookEdit: 'thrusters',
  Bash: 'burpees',
  Read: 'pull-ups',
  Grep: 'pull-ups',
  Glob: 'pull-ups',
  Agent: 'pull-ups',
}

let shown = true
let reps = 0
let byMovement: Record<Movement, number> = { thrusters: 0, burpees: 0, 'pull-ups': 0 }
let lifetime = 0
let startedAt = 0
let frame = 0
let running = false
let movement: Movement = 'thrusters'
let chalkTicks = 0
let norepTicks = 0
let idleTicks = 0
let requestId: string | undefined
let painted = ''
let caption = ''
let tick: { cancel: () => void } | undefined

const round = () => Math.floor(reps / REPS_PER_ROUND)

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

const currentCells = () => {
  if (norepTicks > 0) return NOREP_CELLS
  if (running) {
    const frames = FRAMES[movement]
    return frames[frame % frames.length]!
  }
  if (chalkTicks > 0) return CHALK_CELLS
  if (idleTicks >= REST_TICKS) return REST_CELLS
  return FRAMES[movement][0]!
}

const captionText = (now: number) =>
  [
    running ? clock(now - startedAt) : '',
    round(),
    movement,
    reps % REPS_PER_ROUND,
    running,
    chalkTicks > 0,
    norepTicks > 0,
    reps,
    lifetime,
  ].join('|')

async function paint($: EngineInterface) {
  if (!requestId) return
  const cells = currentCells()
  if (cells === painted) return
  painted = cells
  const r = await $.ui.blit({ requestId, key: RASTER_KEY, cells }).catch(() => ({ deny: 'threw' }))
  if (r.deny) requestId = undefined
}

async function redraw($: EngineInterface) {
  const now = await $.clock.now()
  const text = captionText(now)
  if (text === caption) return
  caption = text
  $.ui.invalidate('ui.render')
}

async function onTick($: EngineInterface) {
  if (norepTicks > 0) norepTicks -= 1
  else if (running) frame += 1
  else {
    if (chalkTicks > 0) chalkTicks -= 1
    idleTicks += 1
  }
  await paint($)
  await redraw($)
}

async function rep($: EngineInterface) {
  reps += 1
  lifetime += 1
  byMovement[movement] += 1
  chalkTicks = CHALK_TICKS
  await $.store.set(LIFETIME_KEY, lifetime).catch(() => undefined)
  if (reps % REPS_PER_ROUND === 0) $.ui.toast(`round ${round()} done`, { timeoutMs: 4000 })
  await redraw($)
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
    startedAt = await $.clock.now()
    tick?.cancel()
    tick = $.clock.every(FRAME_MS, () => void onTick($))
    await $.command
      .register({
        name: 'wod',
        description: 'The pixel athlete above the prompt: reps per tool call, AMRAP clock (wod-band)',
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
      byMovement = { thrusters: 0, burpees: 0, 'pull-ups': 0 }
      startedAt = await $.clock.now()
      $.ui.invalidate('ui.render')
      return { text: '3, 2, 1... clock reset, new AMRAP' }
    }
    if (arg === 'on' || arg === '') {
      shown = true
      await $.store.set(SHOWN_KEY, true).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'wod band on. every tool call is a rep.' }
    }
    return { text: `wod: no such argument "${arg}" — use on, off or reset` }
  })

  on('turn.start', async ($, e, next) => {
    if (disabled) return next(e)
    running = true
    frame = 0
    idleTicks = 0
    await paint($)
    await redraw($)
    return next(e)
  })

  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob|Agent)$/ }, async ($, e, next) => {
    if (disabled) return next(e)
    const next_ = TOOL_MOVEMENT[e.tool]!
    if (next_ !== movement) {
      movement = next_
      frame = 0
    }
    running = true
    idleTicks = 0
    await paint($)
    const r = await next(e)
    if (r.isError === true) {
      norepTicks = NOREP_TICKS
      await paint($)
      await redraw($)
    } else if (r.deny === undefined) await rep($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    running = false
    idleTicks = 0
    await paint($)
    await redraw($)
    return r
  })

  on('turn.abort', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    running = false
    idleTicks = 0
    await paint($)
    await redraw($)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (!shown || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    try {
      const { Box, Text, Raster } = await $.ui.resolve(e)
      const rest = await next(e)
      requestId = e.requestId
      painted = currentCells()
      const now = await $.clock.now()
      caption = captionText(now)
      const inRound = reps % REPS_PER_ROUND
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Raster key={RASTER_KEY} columns={COLUMNS} rows={ROWS} cells={painted} />
            <Box flexDirection="column">
              <Text>
                <Text bold color="#dd3b2a">AMRAP</Text>
                <Text dimColor>{` ${clock(now - startedAt)}`}</Text>
              </Text>
              <Text key="round">
                <Text dimColor>round </Text>
                <Text bold>{`${round() + 1}`}</Text>
                <Text dimColor>{` · ${movement} `}</Text>
                <Text bold>{`${inRound}/${REPS_PER_ROUND}`}</Text>
                {running ? <Text color="yellow"> · working</Text> : null}
                {chalkTicks > 0 && norepTicks === 0 ? <Text color="green"> · rep!</Text> : null}
                {norepTicks > 0 ? <Text bold color="red"> · no rep!</Text> : null}
              </Text>
              <Text key="tally" dimColor>
                {`${reps} reps this session (${MOVEMENTS.map((m) => `${byMovement[m]} ${m}`).join(' · ')}) · ${lifetime} all-time`}
              </Text>
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
