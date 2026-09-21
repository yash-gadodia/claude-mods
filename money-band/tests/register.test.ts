import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { Args, CommandRunInput, On, RenderInput, SessionStartInput } from 'claude-code'

tier('user')

const MIN = 60 * 1000
const REFRESH = 15 * MIN

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const money = (args: string): CommandRunInput => ({
  command: 'money', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const band: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 160, rows: 40, isFullscreen: false },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

const ANSWER = 'NW<120000|900000|60000|823000|2026-09-20>NW\nFIN<2500|31|2026-09-21|900 Freshkitchen>FIN\n'

const textOf = (tree: unknown): string => {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree !== 'object' || !tree) return ''
  return textOf(Reflect.get(tree, 'children') ?? [])
}

function world(on: On) {
  const runs: Args<'process.run'>[] = []
  const logs: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: [''] }))
  on('process.run', ($, e) => {
    runs.push(e)
    return { value: { exitCode: 0, stdout: ANSWER, stderr: '' } }
  })
  return { runs, clock, logs }
}

describe('timer', () => {
  test('the start primes one fetch and arms one timer, which re-arms once after each fire', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    expect(w.runs).toHaveLength(1)
    expect(w.runs[0]!.argv.slice(0, 5)).toEqual(['ssh', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'])
    await w.clock.advance(REFRESH - 1)
    expect(w.runs).toHaveLength(1)
    await w.clock.advance(1)
    expect(w.runs).toHaveLength(2)
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(3)
  })

  test('/money off stops the timer and nothing runs until /money on', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    expect(await $.command.run(money('off'))).toEqual({ text: 'money band off' })
    await w.clock.advance(3 * REFRESH)
    expect(w.runs).toHaveLength(1)
    const r = await $.command.run(money('on'))
    expect(r.text).toMatch(/^net worth {9}S\$257,000/)
    expect(w.runs).toHaveLength(2)
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(3)
  })

  test('/money refresh re-arms rather than forking a second timer', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    await $.command.run(money('refresh'))
    expect(w.runs).toHaveLength(2)
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(3)
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(4)
  })

  // fetchMoney's own process.run is caught inside it; its clock read is the call that can reject,
  // and this plugin sits beneath money-band to refuse the second one.
  const clockOffOnce: Plugin = {
    name: 'clock-off-once',
    tier: 'append',
    register(on) {
      let reads = 0
      on('clock.now', ($, e, next) => (++reads === 2 ? { deny: 'clock off' } : next(e)))
    },
  }

  test('a refresh that rejects is logged once and the next one still comes', { plugins: [clockOffOnce] }, async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(2)
    expect(w.logs).toEqual([expect.stringMatching(/^money-band: refresh failed, trying again in 15m: .*clock off/)])
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(3)
    expect(w.logs).toHaveLength(1)
  })

  test('the band draws the figures the databases answered', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    const line = textOf(await $.ui.render(band))
    expect(line).toContain('net S$257k')
    expect(line).toContain('liquid S$120k')
    expect(line).toContain('debt S$823k')
    expect(line).toContain('spent this month S$2.5k')
  })
})
