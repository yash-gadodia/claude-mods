import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Args, CommandRunInput, On, SessionStartInput } from 'claude-code'

tier('user')

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__claude-in-chrome__navigate': { url: string }
    'mcp__claude-in-chrome__read_page': { filter: string }
    'mcp__claude-in-chrome__list_connected_browsers': { filter?: string }
  }
}

const VOLTY = 'aaaaaaaa-1111-4444-8888-000000000001'
const BONPET = 'bbbbbbbb-2222-4444-8888-000000000002'
const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const chromep = (args: string): CommandRunInput => ({
  command: 'chromep', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

// The world beneath the mod: the map file under HOME, the extension's two connected profiles, and
// a select_browser that accepts any deviceId.
function world(on: On) {
  mock.store(on, {})
  mock.env(on, { HOME: '/home/yash' })
  const mcp: Args<'mcp.call'>[] = []
  const ran: Args<'tool.call'>[] = []
  const runs: (readonly string[])[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    if (e.argv[0] === 'cat') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ default: 'volty', browsers: { volty: VOLTY, bonpet: BONPET } }), stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unscripted' } }
  })
  on('mcp.call', ($, e) => {
    mcp.push(e)
    if (e.tool === 'list_connected_browsers') {
      return { value: { isError: false, content: [{ type: 'text', text: `Connected browsers: ${JSON.stringify([{ deviceId: VOLTY, name: 'Browser 1' }, { deviceId: BONPET, name: 'Browser 2' }])}` }] } }
    }
    return { value: { isError: false, content: [{ type: 'text', text: 'selected' }] } }
  })
  on('tool.call', ($, e) => {
    ran.push(e)
    return { result: 'ok' }
  })
  return { mcp, ran, runs }
}

describe('chrome-switch', () => {
  test('/chromep <label> selects that deviceId without a pairing broadcast', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    const r = await $.command.run(chromep('bonpet'))
    expect(r.text).toBe('driving bonpet')
    expect(w.mcp.map(c => c.tool)).toEqual(['list_connected_browsers', 'select_browser'])
    expect(w.mcp[1]).toEqual({ server: 'claude-in-chrome', tool: 'select_browser', args: { deviceId: BONPET } })
    expect(w.runs[0]).toEqual(['cat', '/home/yash/.claude/chrome-browsers.json'])
  })

  test('the first browser call selects the default deviceId, then passes through', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    const r = await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'https://example.com' })
    expect(r).toEqual({ result: 'ok' })
    expect(w.mcp).toEqual([{ server: 'claude-in-chrome', tool: 'select_browser', args: { deviceId: VOLTY } }])
    expect(w.ran).toHaveLength(1)
    expect(w.ran[0]).toMatchObject({ tool: 'mcp__claude-in-chrome__navigate', url: 'https://example.com' })
    await $.tool.call({ tool: 'mcp__claude-in-chrome__read_page', filter: 'interactive' })
    expect(w.mcp, 'selected once per session').toHaveLength(1)
  })

  test('list_connected_browsers carries the map so the model calls select_browser', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    const r = await $.tool.call({ tool: 'mcp__claude-in-chrome__list_connected_browsers' })
    expect(w.mcp).toEqual([])
    expect(r.context?.[0]).toContain(`volty = ${VOLTY}, bonpet = ${BONPET}; the default is volty`)
    expect(r.context?.[0]).toContain('Call select_browser with the right deviceId rather than switch_browser')
  })

  test('an unrelated tool is untouched', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(r).toEqual({ result: 'ok' })
    expect(w.mcp).toEqual([])
    expect(w.runs).toEqual([])
  })
})
