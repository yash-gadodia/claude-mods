import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { On, RenderInput, SessionMeasureInput, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { accountIn, countdown } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const NOW = 1_700_000_000_000

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work/volty' }

const band = (bodyColumns = 160): RenderInput<'AbovePrompt'> => ({
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: bodyColumns, rows: 40, isFullscreen: false },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
})

const measure = (over: Partial<SessionMeasureInput> = {}): SessionMeasureInput => ({
  context: { window: 1_000_000, tokens: 120_000, percent: 12 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 15, resetsAt: new Date(NOW + 2 * HOUR + 10 * MIN).toISOString() },
    { kind: 'seven_day', percentUsed: 40 },
  ],
  cost: { usd: 1.5 },
  changed: ['context', 'rateLimits', 'cost'],
  ...over,
})

type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
  usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 5_000, model: 'claude-fable-5-1' },
  ...over,
})

const textOf = (tree: unknown): string => {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree !== 'object' || !tree) return ''
  const props: unknown = Reflect.get(tree, 'props')
  const label = typeof props === 'object' && props ? Reflect.get(props, 'label') : undefined
  return `${typeof label === 'string' ? label : ''}${textOf(Reflect.get(tree, 'children') ?? [])}`
}

function world(on: On, env: Record<string, string> = {}) {
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  mock.env(on, env)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.cwd', () => ({ value: '/work/volty' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: [''] }))
  return { clock, toasts }
}

describe('account file', () => {
  test('a half-written ~/.claude.json is unreadable, a logged-out one is a logout', async () => {
    expect(accountIn('{"oauthAccount":{"emailAddress":"yash@voltade.com"}}')).toEqual({ email: 'yash@voltade.com' })
    expect(accountIn('{')).toBe(undefined)
    expect(accountIn('{"oauthAccount":{}}')).toEqual({ email: undefined })
  })
})

describe('countdown', () => {
  test('reads as hours and minutes', async () => {
    expect(countdown(2 * HOUR + 10 * MIN)).toBe('2h10m')
    expect(countdown(7 * MIN)).toBe('7m')
    expect(countdown(-5)).toBe('0m')
  })
})

describe('band', () => {
  test('a measurement draws the windows, the countdown to the 5h reset and the context', async ($, on) => {
    world(on)
    await $.session.start(session)
    expect(textOf(await $.ui.render(band()))).toContain('no reading yet')
    await $.session.measure(measure())
    const line = textOf(await $.ui.render(band()))
    expect(line).toContain('5h 15% ↻2h10m')
    expect(line).toContain('7d 40%')
    expect(line).toContain('ctx 12% 120k')
    expect(line).toContain('$1.50')
    expect(line).toContain('volty')
  })

  test('the countdown moves with the clock', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.session.measure(measure())
    await w.clock.advance(HOUR)
    expect(textOf(await $.ui.render(band()))).toContain('↻1h10m')
  })

  test('the turn adds its own token delta, dropped first when the band is narrow', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.session.measure(measure())
    await $.turn.complete(turn())
    const wide = textOf(await $.ui.render(band()))
    expect(wide).toContain('last 2k in · 300 out · 45k cache')
    const narrow = textOf(await $.ui.render(band(70)))
    expect(narrow).not.toContain('last ')
    expect(narrow).toContain('5h 15% ↻2h10m')
  })

  test('a subagent turn moves nothing', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.session.measure(measure())
    await $.turn.complete(turn({ agentId: 'a1' }))
    expect(textOf(await $.ui.render(band()))).not.toContain('last ')
  })

  test('the context nudge toasts once per tenth past the threshold', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.session.measure(measure({ context: { window: 1_000_000, tokens: 560_000, percent: 56 } }))
    await $.session.measure(measure({ context: { window: 1_000_000, tokens: 580_000, percent: 58 } }))
    await $.session.measure(measure({ context: { window: 1_000_000, tokens: 660_000, percent: 66 } }))
    expect(w.toasts).toEqual([
      'context 56% · /clear if the next thing is a new task, /compact to keep going',
      'context 66% · /clear if the next thing is a new task, /compact to keep going',
    ])
    expect(textOf(await $.ui.render(band()))).toContain('/clear on a new task')
  })

  test('CLAUDE_MODS_DISABLE passes every hook through', async ($, on) => {
    world(on, { CLAUDE_MODS_DISABLE: 'usage-band' })
    await $.session.start(session)
    await $.session.measure(measure())
    expect(textOf(await $.ui.render(band()))).toBe('')
  })
})
