import { describe, expect, mock, test, tier, type Engine } from 'claude-code/testing'
import type { Args, CommandRunInput, On, SessionStartInput, TurnCompleteInput } from 'claude-code'

tier('user')

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const complete = (reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string): TurnCompleteInput =>
  ({ answer: 'done', durationMs: 1000, isAborted: reason === 'aborted', turnId: 't1', reason, ...(agentId === undefined ? {} : { agentId }) }) as TurnCompleteInput

const cmd = (args: string): CommandRunInput => ({ command: 'done-blink', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const submit = ($: Engine, text = 'next') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

function world(on: On, env: Record<string, string> = {}) {
  const runs: Args<'process.run'>[] = []
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  mock.env(on, env)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('process.run', ($, e) => { runs.push(e); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  return { runs, store }
}

const kind = (run: Args<'process.run'>) => (String(run.argv[2]).includes('nohup') ? 'start' : 'stop')
const secondsOf = (run: Args<'process.run'>) => run.argv[4]

describe('done-blink', () => {
  test('a landed main turn spawns the blink loop with the default ceiling', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(complete())
    expect(w.runs.length).toBe(1)
    expect(w.runs[0]!.argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(kind(w.runs[0]!)).toBe('start')
    expect(secondsOf(w.runs[0]!)).toBe('180')
    expect(String(w.runs[0]!.argv[2])).toContain(']6;1;bg;')
  })

  test('the next prompt stops it and restores the colour, once', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(complete())
    await submit($)
    await $.turn.start({ text: 'next', turnId: 't2' })
    expect(w.runs.map(kind)).toEqual(['start', 'stop'])
  })

  test('a prompt with no blink running spawns nothing', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await submit($, 'first')
    expect(w.runs.length).toBe(0)
  })

  test('a subagent turn and an interrupted turn do not blink', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(complete('answer', 'agent-1'))
    await $.turn.complete(complete('aborted'))
    expect(w.runs.length).toBe(0)
  })

  test('/done-blink 30 sets the ceiling and persists it', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    const r = await $.command.run(cmd('30'))
    expect(r.text).toBe('done-blink blinks for up to 30s')
    await $.turn.complete(complete())
    expect(secondsOf(w.runs[0]!)).toBe('30')
    expect(w.store.get('done-blink:seconds')).toBe(30)
  })

  test('/done-blink off stops any blink and turns the mod off', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(complete())
    await $.command.run(cmd('off'))
    await $.turn.complete(complete())
    expect(w.runs.map(kind)).toEqual(['start', 'stop'])
    expect(w.store.get('done-blink:enabled')).toBe(false)
  })

  test('CLAUDE_MODS_DISABLE makes it a pass-through', async ($, on) => {
    const w = world(on, { CLAUDE_MODS_DISABLE: 'done-blink' })
    await $.session.start(session)
    await $.turn.complete(complete())
    expect(w.runs.length).toBe(0)
  })
})
