import { describe, expect, mock, test, tier, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

tier('user')

const SESSION = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const BEAT = 450

const spinner = () => ({
  surface: 'terminal' as const,
  component: 'Spinner' as const,
  requestId: 'agent-main',
  viewport: { columns: 80, rows: 24 },
  props: { word: 'Cooking', message: null, suffix: '…', mode: 'requesting' as const },
})

const duration = (requestId: string, durationMs: number) => ({
  surface: 'terminal' as const,
  component: 'TurnDuration' as const,
  requestId,
  viewport: { columns: 80, rows: 24 },
  props: { word: 'Cooked', durationMs },
})

const band = () => ({
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  requestId: 'band-1',
  viewport: { columns: 80, rows: 24 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
})

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  mock.env(on, {})
  const invalidations: string[] = []
  let dropNext: string | undefined
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => (dropNext === undefined ? { text: e.text } : { drop: dropNext }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.invalidate', ($, e) => { invalidations.push(e.event); return { value: undefined } })
  on('ui.render', ($, e) => ({
    type: 'Text',
    props: {},
    children: [e.component === 'Spinner' || e.component === 'TurnDuration' ? String(e.props.word) : 'STOCK'],
  }))
  return { clock, invalidations, drop: (reason: string) => { dropNext = reason } }
}

const shown = async ($: Engine, input: ReturnType<typeof spinner> | ReturnType<typeof duration>) => {
  const tree = await $.ui.render(input)
  return tree.type === 'Text' ? String(tree.children?.[0]) : tree.type
}

const step = async ($: Engine, turnId: string) => {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-fable-5-1', messageCount: 1 })
  let s = await stream.next()
  while (!s.done) s = await stream.next()
}

const submit = ($: Engine, text = 'hi') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const complete = ($: Engine, turnId: string) =>
  $.turn.complete({ answer: 'done', durationMs: 65_000, isAborted: false, turnId, reason: 'answer' })

describe('wod-timer', () => {
  test('the spinner word counts 3, 2, 1, GO as the clock advances', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await submit($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(await shown($, spinner())).toBe('3')
    await w.clock.advance(BEAT)
    expect(await shown($, spinner())).toBe('2')
    await w.clock.advance(BEAT)
    expect(await shown($, spinner())).toBe('1')
    await w.clock.advance(BEAT)
    expect(await shown($, spinner())).toBe('GO')
    await w.clock.advance(BEAT)
    expect(await shown($, spinner())).toBe('Cooking')
  })

  test('the split appears in TurnDuration after turn.complete, from the first request', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await submit($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.advance(2_000)
    await step($, 't1')
    await w.clock.advance(65_000)
    await complete($, 't1')
    expect(await shown($, duration('m1', 65_000))).toBe('Split 1:05 (avg 1:05 · longest 1:05 · 1 turns) · Cooked')
    expect(await shown($, duration('m1', 65_000))).toBe('Split 1:05 (avg 1:05 · longest 1:05 · 1 turns) · Cooked')
    expect(await shown($, duration('m0', 10_000))).toBe('Cooked')
    await submit($)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await step($, 't2')
    await w.clock.advance(30_000)
    await complete($, 't2')
    expect(await shown($, duration('m2', 30_000))).toBe('Split 0:30 (avg 0:47 · longest 1:05 · 2 turns) · Cooked')
    expect(await shown($, duration('m1', 65_000))).toBe('Split 1:05 (avg 0:47 · longest 1:05 · 2 turns) · Cooked')
  })

  test('the band runs a clock from the request and idles with the split', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await submit($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.advance(BEAT * 4)
    await step($, 't1')
    await w.clock.advance(12_000)
    expect(JSON.stringify(await $.ui.render(band()))).toMatch(/0:12/)
    await complete($, 't1')
    expect(JSON.stringify(await $.ui.render(band()))).toMatch(/split /)
    const ticking = w.invalidations.length
    await w.clock.advance(10_000)
    expect(w.invalidations.length).toBe(ticking)
  })

  test('invalidates are coalesced to at least 100ms apart', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await submit($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(w.invalidations.length).toBe(1)
    await w.clock.advance(50)
    await submit($)
    expect(w.invalidations.length).toBe(1)
  })

  test('a dropped submit leaves no ticker running and the spinner word untouched', async ($, on) => {
    const w = world(on)
    w.drop('guard said no')
    await $.session.start(SESSION)
    const r = await submit($)
    expect(r.drop).toBe('guard said no')
    expect(await shown($, spinner())).toBe('Cooking')
    const before = w.invalidations.length
    await w.clock.advance(BEAT * 4 + 5_000)
    expect(w.invalidations.length).toBe(before)
    expect(await shown($, spinner())).toBe('Cooking')
  })

  test('a slash command does not count down', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await submit($, '/scope 5')
    expect(w.invalidations.length).toBe(0)
    expect(await shown($, spinner())).toBe('Cooking')
    await w.clock.advance(BEAT * 4 + 5_000)
    expect(w.invalidations.length).toBe(0)
  })
})
