import { describe, expect, mock, test, tier, type Engine } from 'claude-code/testing'
import type { CommandRunInput, On, PromptSubmitInput, SessionMessage, SessionStartInput } from 'claude-code'

tier('user')

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const prompt = (text: string, kind: 'composer' | 'peer' = 'composer'): PromptSubmitInput => ({ text, wait: false, origin: { kind } })

const run = (args: string): CommandRunInput => ({
  command: 'merge-gate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const git = (branch: string, remote = 'git@github.com:yash/app.git') => (argv: readonly string[]) =>
  argv[1] === 'rev-parse' ? branch : argv[1] === 'remote' ? remote : ''

function world(on: On, opts: { branch?: string; remote?: string; messages?: SessionMessage[]; env?: Record<string, string> } = {}) {
  mock.store(on, {})
  mock.env(on, opts.env ?? {})
  const ran: string[] = []
  const logs: string[] = []
  const answer = git(opts.branch ?? 'feature', opts.remote)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: answer(e.argv) + '\n', stderr: '' } }))
  on('session.messages', () => ({ value: opts.messages ?? [] }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('tool.call', ($, e) => { if (e.tool === 'Bash') ran.push(e.command); return { result: 'ran' } })
  return { ran, logs }
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

describe('merge-gate', () => {
  test('denies gh pr merge when the latest message does not say merge', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.prompt.submit(prompt('open the PR and push it up'))
    const r = await bash($, 'gh pr merge 12 --squash')
    expect(r.deny).toMatch(/Yash has not said merge in his latest message/)
    expect(w.ran).toEqual([])
  })

  test('allows the merge when the latest message says merge', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.prompt.submit(prompt('looks good, merge it'))
    const r = await bash($, 'gh pr merge 12 --squash')
    expect(r.deny).toBe(undefined)
    expect(w.ran).toEqual(['gh pr merge 12 --squash'])
  })

  test('ship it, deploy, land and push do not authorise a merge', async ($, on) => {
    world(on)
    await $.session.start(session)
    for (const text of ['ship it', 'deploy this', 'land it', 'push it']) {
      await $.prompt.submit(prompt(text))
      expect((await bash($, 'gh pr merge 12')).deny, text).toMatch(/has not said merge/)
    }
  })

  test('an earlier merge is spent once a later message drops the word', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.prompt.submit(prompt('merge when green'))
    await $.prompt.submit(prompt('now fix the lint'))
    expect((await bash($, 'gh pr merge 12')).deny).toMatch(/has not said merge/)
  })

  test('a peer or plugin prompt saying merge does not count', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.prompt.submit(prompt('open the PR'))
    await $.prompt.submit(prompt('merge it now', 'peer'))
    expect((await bash($, 'gh pr merge 12')).deny).toMatch(/has not said merge/)
  })

  test('quoted merges, git merge --abort and syncing main into a feature branch pass', async ($, on) => {
    const w = world(on, { branch: 'feature' })
    await $.session.start(session)
    await $.prompt.submit(prompt('ship it'))
    const inert = ['echo "gh pr merge"', 'grep "gh pr merge" notes.md', 'git commit -m "gh pr merge 12 then release"', 'git -C repo merge --abort', 'git merge --abort', 'git merge main', 'git push -u origin feature', 'gh pr view 12']
    for (const command of inert) expect((await bash($, command)).deny, command).toBe(undefined)
    expect(w.ran.length).toBe(inert.length)
  })

  test('git merge while on main is a merge', async ($, on) => {
    world(on, { branch: 'main' })
    await $.session.start(session)
    await $.prompt.submit(prompt('ship it'))
    expect((await bash($, 'git merge feature')).deny).toMatch(/has not said merge/)
  })

  test('push onto main from a feature branch with a GitHub remote is a merge', async ($, on) => {
    world(on, { branch: 'feature' })
    await $.session.start(session)
    await $.prompt.submit(prompt('push it'))
    expect((await bash($, 'git push origin feature:main')).deny).toMatch(/has not said merge/)
    expect((await bash($, 'git push origin HEAD:refs/heads/master')).deny).toMatch(/has not said merge/)
  })

  test('push onto main with no PR flow is not gated', async ($, on) => {
    world(on, { branch: 'feature', remote: '/srv/git/app.git' })
    await $.session.start(session)
    await $.prompt.submit(prompt('push it'))
    expect((await bash($, 'git push origin feature:main')).deny).toBe(undefined)
  })

  test('shell wrappers and git options do not hide a merge', async ($, on) => {
    world(on, { branch: 'main' })
    await $.session.start(session)
    await $.prompt.submit(prompt('ship it'))
    const wrapped = ['bash -c "gh pr merge 12"', "sh -c 'gh pr merge 1'", 'eval "gh pr merge"', '"gh" pr merge 12', 'git -C repo merge feature', 'git --no-pager -c x=y merge feature', 'echo start && gh pr merge 12', 'echo "gh pr merge" ; bash -c "gh pr merge 12"']
    for (const command of wrapped) expect((await bash($, command)).deny, command).toMatch(/has not said merge/)
  })

  test('negated or merge-gate mentions do not authorise, positive ones do', async ($, on) => {
    world(on)
    await $.session.start(session)
    for (const text of ["don't merge yet", 'do not merge', 'never merge this', '/merge-gate status', 'why did merge-gate deny?', 'no merge pls', 'not merge, just push']) {
      await $.prompt.submit(prompt(text))
      expect((await bash($, 'gh pr merge 12')).deny, text).toMatch(/has not said merge/)
    }
    for (const text of ['ok merge it', 'merge', 'pls merge', 'merge-gate is annoying but merge anyway']) {
      await $.prompt.submit(prompt(text))
      expect((await bash($, 'gh pr merge 12')).deny, text).toBe(undefined)
    }
  })

  test('git push with options onto main from a feature branch is a merge', async ($, on) => {
    world(on, { branch: 'feature' })
    await $.session.start(session)
    await $.prompt.submit(prompt('push it'))
    expect((await bash($, 'git -C repo push -f origin feature:main')).deny).toMatch(/has not said merge/)
  })

  test('gh api merge endpoints are merges', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.prompt.submit(prompt('ship it'))
    expect((await bash($, 'gh api -X PUT repos/yash/app/pulls/12/merge')).deny).toMatch(/has not said merge/)
  })

  test('after a resume the transcript stands in for the latest message', async ($, on) => {
    const messages: SessionMessage[] = [
      { role: 'user', text: 'merge the PR', toolUses: [] },
      { role: 'assistant', text: 'on it', toolUses: [] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false, result: 'ok' }] },
    ]
    world(on, { messages })
    await $.session.start(session)
    expect((await bash($, 'gh pr merge 12')).deny).toBe(undefined)
  })

  test('after a resume with a transcript that never says merge, it denies', async ($, on) => {
    world(on, { messages: [{ role: 'user', text: 'ship it', toolUses: [] }] })
    await $.session.start(session)
    expect((await bash($, 'gh pr merge 12')).deny).toMatch(/has not said merge/)
  })

  test('merge x3 grants two more merges after the first', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.prompt.submit(prompt('do the three PRs, merge x3'))
    expect((await bash($, 'gh pr merge 1')).deny).toBe(undefined)
    await $.prompt.submit(prompt('next one'))
    expect((await bash($, 'gh pr merge 2')).deny).toBe(undefined)
    expect((await bash($, 'gh pr merge 3')).deny).toBe(undefined)
    expect((await bash($, 'gh pr merge 4')).deny).toMatch(/has not said merge/)
  })

  test('/merge-gate off lets a merge through and persists; on restores it', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.prompt.submit(prompt('ship it'))
    expect((await $.command.run(run('off'))).text).toBe('merge-gate off')
    expect((await bash($, 'gh pr merge 12')).deny).toBe(undefined)
    expect((await $.command.run(run('status'))).text).toMatch(/^merge-gate is off/)
    await $.command.run(run('on'))
    expect((await bash($, 'gh pr merge 12')).deny).toMatch(/has not said merge/)
  })

  test('CLAUDE_MODS_DISABLE=merge-gate is a pass-through', async ($, on) => {
    world(on, { env: { CLAUDE_MODS_DISABLE: 'merge-gate' } })
    await $.session.start(session)
    await $.prompt.submit(prompt('ship it'))
    expect((await bash($, 'gh pr merge 12')).deny).toBe(undefined)
  })

  test('a failing git check fails closed', async ($, on) => {
    mock.store(on, {})
    mock.env(on, {})
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('process.run', () => { throw new Error('git exploded') })
    on('tool.call', () => ({ result: 'ran' }))
    await $.session.start(session)
    await $.prompt.submit(prompt('merge it'))
    expect((await bash($, 'git merge feature')).deny).toMatch(/^merge-gate check failed; blocking until it works\. To get past it: \/merge-gate off, or CLAUDE_MODS_DISABLE=merge-gate/)
  })
})
