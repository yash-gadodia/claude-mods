import type { On } from 'claude-code'
import { describe, expect, mock, test, tier, type MockClock } from 'claude-code/testing'

tier('user')

const START = 1_700_000_000_000
const SEC = 1000
const RUN = 'https://github.com/o/r/actions/runs/42'
const CONFIG = { '/repo/.claude/deploy-verify.json': '{"url":"https://x.test","match":"v9"}' }

type Run = { databaseId: number; status: string; conclusion: string | null; createdAt: string; url: string; headBranch: string }
type Curl = { status: number; body: string }

type World = {
  files?: Record<string, string>
  ci?: boolean
  runs?: Run[][]
  curl?: Curl[]
  stdout?: string
  breakClock?: boolean
  slowGh?: boolean
}

// Beneath the mod: a checkout at /repo with a config file, `gh run list` answering from a script
// (one entry per poll, the last repeating), curl answering from another, and a Bash that records.
const world = (on: On, options: World = {}) => {
  const ran: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const submitted: string[] = []
  const processes: string[] = []
  const runs = [...(options.runs ?? [])]
  const curls = [...(options.curl ?? [])]
  const clock = options.breakClock ? ({} as MockClock) : mock.clock(on, { now: START })
  mock.env(on, {})
  if (options.breakClock) on('clock.now', () => ({ deny: 'clock is gone' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.github/workflows' ? options.ci === true : options.files?.[e.path] !== undefined }))
  on('fs.read', ($, e) => {
    const text = options.files?.[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('process.run', async ($, e) => {
    processes.push(e.argv.join(' '))
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
    if (e.argv[0] === 'gh') {
      if (options.slowGh) await clock.sleep(5 * SEC)
      const page = runs.length > 1 ? runs.shift() : runs[0]
      return { value: { exitCode: 0, stdout: JSON.stringify(page ?? []), stderr: '' } }
    }
    const answer = curls.length > 1 ? curls.shift() : curls[0]
    if (!answer) return { deny: 'no curl scripted' }
    return { value: { exitCode: 0, stdout: `${answer.body}\n__STATUS__${answer.status}`, stderr: '' } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ran.push(e.command)
    return { result: { stdout: options.stdout ?? '', stderr: '', interrupted: false } }
  })
  const block = async ($: { prompt: { context: (e: { blocks: [] }) => Promise<{ blocks: readonly { name: string; text: string }[] }> } }) =>
    (await $.prompt.context({ blocks: [] })).blocks.find(b => b.name === 'deployVerify')?.text
  return { ran, toasts, logs, submitted, processes, clock, block }
}

const session = { surface: 'terminal' as const, isInteractive: true, cwd: '/repo' }
const bash = (command: string) => ({ tool: 'Bash' as const, command })
const turnEnds = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }
const run = (status: string, conclusion: string | null, at = START + SEC): Run => ({ databaseId: 42, status, conclusion, createdAt: new Date(at).toISOString(), url: RUN, headBranch: 'main' })
const stop = { command: 'deploy-verify', args: 'stop', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

describe('without CI', () => {
  test('a push is verified in the call when the live URL serves the match string', async ($, on) => {
    const w = world(on, { files: CONFIG, curl: [{ status: 200, body: '<html>release v9</html>' }] })
    await $.session.start(session)
    const r = await $.tool.call(bash('git push origin main'))
    expect(r.context?.join('\n')).toContain('VERIFIED live: https://x.test served "v9"')
    expect(w.processes.filter(p => p.startsWith('gh'))).toEqual([])
    expect(w.toasts).toEqual(['deploy-verify: live content confirmed'])
    expect(await w.block($)).toMatch(/Last live deploy check, just now:\n {2}VERIFIED live: https:\/\/x\.test served "v9"/)
  })

  test('a dry run, a quoted push and a plain command add nothing', async ($, on) => {
    const w = world(on, { files: CONFIG, curl: [{ status: 200, body: 'v9' }] })
    await $.session.start(session)
    for (const command of ['git push --dry-run', 'echo "git push"', 'git status']) {
      const r = await $.tool.call(bash(command))
      expect(r.context).toBeUndefined()
    }
    expect(w.ran).toEqual(['git push --dry-run', 'echo "git push"', 'git status'])
    expect(w.processes).toEqual([])
    expect(await w.block($)).toBeUndefined()
  })

  test('a repo with no target gets the advisory once, and never a curl', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    const first = await $.tool.call(bash('git push'))
    const second = await $.tool.call(bash('git push'))
    expect(first.context?.[0]).toContain('NOTHING about the live site has been checked')
    expect(first.context?.[0]).toContain('/repo/.claude/deploy-verify.json')
    expect(second.context).toBeUndefined()
    expect(w.processes).toEqual([])
  })

  test('a gh merge that prints no run URL is checked live at once', async ($, on) => {
    const w = world(on, { files: CONFIG, ci: true, curl: [{ status: 200, body: 'v9' }] })
    await $.session.start(session)
    const r = await $.tool.call(bash('gh pr merge 12 --squash'))
    expect(r.context?.join('\n')).toContain('VERIFIED live')
    expect(w.processes.filter(p => p.startsWith('gh'))).toEqual([])
  })

  test('a failed hook still leaves a note that nothing was checked', async ($, on) => {
    const w = world(on, { files: CONFIG, breakClock: true })
    await $.session.start(session)
    const r = await $.tool.call(bash('git push'))
    expect(w.ran).toEqual(['git push'])
    expect(r.context?.join('\n')).toContain('deploy-verify failed to check this deploy')
    expect(r.context?.join('\n')).toContain('Do not claim the deploy verified')
    expect(w.logs.at(-1)).toMatch(/deploy-verify: the check failed/)
  })
})

describe('with CI', () => {
  test('a failing run is the verdict, no curl is made, and the follow-up waits for the turn', async ($, on) => {
    const w = world(on, {
      files: CONFIG,
      ci: true,
      runs: [[], [run('queued', null)], [run('in_progress', null)], [run('completed', 'failure')]],
      curl: [{ status: 200, body: 'v9' }],
    })
    await $.session.start(session)
    const r = await $.tool.call(bash('git push'))
    expect(r.context?.join('\n')).toContain('NOTHING is verified yet')
    expect(await w.block($)).toContain('CI PENDING for the push')

    await w.clock.advance(15 * SEC)
    await w.clock.advance(15 * SEC)
    expect(w.toasts).toEqual([])
    await w.clock.advance(15 * SEC)
    expect(w.toasts).toEqual([`deploy-verify: CI queued → in_progress (${RUN})`])
    await w.clock.advance(15 * SEC)
    expect(w.toasts.at(-1)).toBe(`deploy-verify: CI in_progress → failure (${RUN})`)
    expect(await w.block($)).toContain(`NOT VERIFIED — CI failed for ${RUN} (failure); no live check was made`)
    expect(w.processes.filter(p => p.startsWith('curl'))).toEqual([])

    expect(w.submitted).toEqual([])
    await $.turn.complete(turnEnds)
    await w.clock.settle()
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toMatch(/the live check for the last deploy never passed/)
    expect(w.submitted[0]).toContain(`CI failed for ${RUN}`)
    await $.turn.complete(turnEnds)
    await w.clock.settle()
    expect(w.submitted).toHaveLength(1)
  })

  test('a passing run hands over to the live watch, which toasts on a status change and follows up when it never passes', async ($, on) => {
    const w = world(on, {
      files: CONFIG,
      ci: true,
      runs: [[run('completed', 'success')]],
      curl: [{ status: 200, body: 'old v8' }, { status: 200, body: 'old v8' }, { status: 503, body: '' }],
    })
    await $.session.start(session)
    await $.tool.call(bash('git push'))
    await $.turn.complete(turnEnds)

    await w.clock.advance(15 * SEC)
    expect(w.toasts).toEqual([])
    expect(await w.block($)).toContain(`CI passed: ${RUN}`)
    await w.clock.advance(15 * SEC)
    await w.clock.advance(15 * SEC)
    expect(w.toasts).toEqual([])
    await w.clock.advance(15 * SEC)
    expect(w.toasts).toEqual(['deploy-verify: https://x.test went HTTP 200 → 503'])
    for (let i = 0; i < 9; i++) await w.clock.advance(15 * SEC)
    expect(w.toasts.at(-1)).toMatch(/still not live after 3 minutes/)
    expect(await w.block($)).toMatch(/CI passed.*\n {2}NOT VERIFIED https:\/\/x\.test — HTTP 503/)
    await w.clock.settle()
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('NOT VERIFIED https://x.test — HTTP 503')
    await w.clock.advance(60 * SEC)
    expect(w.processes.filter(p => p.startsWith('curl'))).toHaveLength(12)
  })

  test('a run that lands during the watch is verified and toasts once', async ($, on) => {
    const w = world(on, { files: CONFIG, ci: true, runs: [[run('completed', 'success')]], curl: [{ status: 200, body: 'v8' }, { status: 200, body: 'v9' }] })
    await $.session.start(session)
    await $.tool.call(bash('git push'))
    await w.clock.advance(15 * SEC)
    await w.clock.advance(15 * SEC)
    await w.clock.advance(15 * SEC)
    expect(w.toasts).toEqual(['deploy-verify: live now — VERIFIED live: https://x.test served "v9"'])
    expect(await w.block($)).toMatch(/VERIFIED live: https:\/\/x\.test served "v9"/)
    await $.turn.complete(turnEnds)
    await w.clock.settle()
    expect(w.submitted).toEqual([])
  })

  test('a gh command is matched to the run it printed, older runs ignored', async ($, on) => {
    const older = { ...run('in_progress', null, START - 60 * SEC), databaseId: 7, url: 'https://github.com/o/r/actions/runs/7' }
    const w = world(on, { files: CONFIG, ci: true, stdout: `Run started: ${RUN}\n`, runs: [[older, run('completed', 'success', START - 30 * SEC)]], curl: [{ status: 200, body: 'v9' }] })
    await $.session.start(session)
    const r = await $.tool.call(bash('gh workflow run release.yml'))
    expect(r.context?.join('\n')).toContain(`the run for ${RUN} is being watched`)
    await w.clock.advance(15 * SEC)
    await w.clock.advance(15 * SEC)
    expect(await w.block($)).toMatch(/CI passed: .*runs\/42\n {2}VERIFIED live/)
  })

  test('a pull request is watched for CI but never curled', async ($, on) => {
    const w = world(on, { files: CONFIG, ci: true, stdout: 'https://github.com/o/r/pull/9\n', runs: [[run('completed', 'success')]], curl: [{ status: 200, body: 'v9' }] })
    await $.session.start(session)
    const r = await $.tool.call(bash('gh pr create --fill'))
    expect(r.context?.join('\n')).toContain('https://github.com/o/r/pull/9 is being watched')
    await w.clock.advance(15 * SEC)
    expect(await w.block($)).toContain(`CI passed: ${RUN}`)
    await w.clock.advance(60 * SEC)
    expect(w.processes.filter(p => p.startsWith('curl'))).toEqual([])
  })

  test('/deploy-verify stop ends the watch', async ($, on) => {
    const w = world(on, { files: CONFIG, ci: true, runs: [[run('queued', null)]] })
    await $.session.start(session)
    await $.tool.call(bash('git push'))
    await w.clock.advance(15 * SEC)
    const r = await $.command.run(stop)
    expect(r.text).toBe('deploy-verify: watcher stopped')
    await w.clock.advance(60 * SEC)
    expect(w.processes.filter(p => p.startsWith('gh'))).toHaveLength(1)
  })

  test('a stop that lands while a poll is in flight ends the loop, which does not re-arm', async ($, on) => {
    const w = world(on, { files: CONFIG, ci: true, slowGh: true, runs: [[run('completed', 'success')]], curl: [{ status: 200, body: 'v9' }] })
    await $.session.start(session)
    await $.tool.call(bash('git push'))
    await w.clock.advance(15 * SEC)
    expect(w.processes.filter(p => p.startsWith('gh'))).toHaveLength(1)
    await $.command.run(stop)
    await w.clock.advance(5 * SEC)
    await w.clock.advance(120 * SEC)
    expect(w.processes.filter(p => p.startsWith('gh'))).toHaveLength(1)
    expect(w.processes.filter(p => p.startsWith('curl'))).toEqual([])
    expect(await w.block($)).toContain('CI PENDING')
    expect(w.toasts).toEqual([])
  })

  test('a new deploy mid-poll takes over; the old loop records nothing over it', async ($, on) => {
    const w = world(on, {
      files: CONFIG,
      ci: true,
      slowGh: true,
      runs: [[run('completed', 'success')], [{ ...run('completed', 'failure', START + 16 * SEC), databaseId: 43, url: 'https://github.com/o/r/actions/runs/43' }]],
      curl: [{ status: 200, body: 'v9' }],
    })
    await $.session.start(session)
    await $.tool.call(bash('git push'))
    await w.clock.advance(15 * SEC)
    await $.tool.call(bash('git push'))
    await w.clock.advance(5 * SEC)
    expect(await w.block($)).toContain('CI PENDING')
    expect(w.processes.filter(p => p.startsWith('curl'))).toEqual([])
    await w.clock.advance(15 * SEC)
    expect(w.processes.filter(p => p.startsWith('gh'))).toHaveLength(2)
    expect(await w.block($)).toContain('CI failed for https://github.com/o/r/actions/runs/43')
    await $.turn.complete(turnEnds)
    await w.clock.settle()
    expect(w.submitted).toHaveLength(1)
  })

  test('only the deploying branch counts: a newer _offload run is ignored', async ($, on) => {
    const offload = { ...run('in_progress', null, START + 2 * SEC), databaseId: 43, url: 'https://github.com/o/r/actions/runs/43', headBranch: '_offload/main' }
    const w = world(on, { files: CONFIG, ci: true, runs: [[offload, run('completed', 'success')]], curl: [{ status: 200, body: 'v9' }] })
    await $.session.start(session)
    await $.tool.call(bash('git push origin main'))
    await w.clock.advance(15 * SEC)
    expect(w.processes.find(p => p.startsWith('gh'))).toContain('--branch main')
    expect(w.processes.find(p => p.startsWith('git'))).toBeUndefined()
    expect(await w.block($)).toContain(`CI passed: ${RUN}`)
    await w.clock.advance(15 * SEC)
    expect(await w.block($)).toContain('VERIFIED live')
  })

  test('a bare push asks git for the branch', async ($, on) => {
    const w = world(on, { files: CONFIG, ci: true, runs: [[run('completed', 'success')]], curl: [{ status: 200, body: 'v9' }] })
    await $.session.start(session)
    await $.tool.call(bash('git push'))
    await w.clock.advance(15 * SEC)
    expect(w.processes).toContain('git rev-parse --abbrev-ref HEAD')
    expect(w.processes.find(p => p.startsWith('gh'))).toContain('--branch main')
  })
})
