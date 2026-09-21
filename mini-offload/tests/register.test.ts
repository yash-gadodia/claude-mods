import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Args, On, SessionStartInput } from 'claude-code'

tier('user')

const SHA = 'abc123abc123abc123abc123abc123abc123abc1'
const session = (cwd: string): SessionStartInput => ({ surface: 'terminal', isInteractive: true, cwd })

type Answer = { exitCode?: number; stdout?: string; stderr?: string }

// The world beneath the mod: the mode it saved, a git checkout at `cwd` on the laptop, and an ssh
// that answers from `sshAnswer` for every remote call.
function world(on: On, opts: { mode: string; cwd: string; sshAnswer: Answer }) {
  mock.store(on, { 'mini-offload:mode': opts.mode })
  mock.env(on, {})
  const ran: Args<'tool.call'>[] = []
  const runs: (readonly string[])[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: opts.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: false }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', ($, e) => {
    ran.push(e)
    return { result: 'ok' }
  })
  on('process.run', ($, e) => {
    runs.push(e.argv)
    const words = e.argv.join(' ')
    if (e.argv[0] === 'ssh') return { value: { exitCode: 0, stdout: '', stderr: '', ...opts.sshAnswer } }
    if (/rev-parse HEAD$/.test(words)) return { value: { exitCode: 0, stdout: `${SHA}\n`, stderr: '' } }
    if (/rev-parse --abbrev-ref HEAD$/.test(words)) return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
    if (/status --porcelain/.test(words)) return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (/ push --force/.test(words)) return { value: { exitCode: 0, stdout: '', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: `unscripted: ${words}` } }
  })
  return { ran, runs }
}

describe('routing', () => {
  test('always: a heavy command is rewritten to ssh with the PATH export and cd', async ($, on) => {
    const w = world(on, { mode: 'always', cwd: '/work/always', sshAnswer: { stdout: `${SHA}\n` } })
    await $.session.start(session('/work/always'))
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(w.ran).toHaveLength(1)
    expect(w.ran[0]?.tool).toBe('Bash')
    expect((w.ran[0] as { command: string }).command).toBe(
      `ssh mini 'export PATH=/opt/homebrew/bin:$PATH; cd '\\''/work/always'\\'' && npm test'`,
    )
    expect((w.ran[0] as { timeout?: number }).timeout).toBe(600000)
    expect(w.runs[0]).toEqual(['ssh', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', 'mini', "test -d '/work/always'"])
    expect(w.runs.some(argv => argv.join(' ').endsWith('rev-parse HEAD'))).toBe(true)
    expect(r.context?.join(' ')).toContain('mini-offload ran this on mini in /work/always')
  })

  test('off: the command passes through untouched and nothing is asked of ssh', async ($, on) => {
    const w = world(on, { mode: 'off', cwd: '/work/off', sshAnswer: {} })
    await $.session.start(session('/work/off'))
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(r).toEqual({ result: 'ok' })
    expect((w.ran[0] as { command: string }).command).toBe('npm test')
    expect(w.runs).toEqual([])
  })

  test('always: an ssh failure denies with the fix, and the command never runs here', async ($, on) => {
    const w = world(on, { mode: 'always', cwd: '/work/down', sshAnswer: { exitCode: 255, stderr: 'ssh: connect to host mini port 22: Operation timed out' } })
    await $.session.start(session('/work/down'))
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(r.deny).toMatch(/^mini-offload failed to route this command to the mini \(ssh mini: ssh: connect to host mini port 22: Operation timed out\); run it locally with \/mini off or fix ssh$/)
    expect(w.ran).toEqual([])
  })

  test('always: a light command is not routed', async ($, on) => {
    const w = world(on, { mode: 'always', cwd: '/work/light', sshAnswer: { exitCode: 255 } })
    await $.session.start(session('/work/light'))
    const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(r).toEqual({ result: 'ok' })
    expect(w.runs).toEqual([])
  })
})
