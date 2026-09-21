/* @jsx h */
import type { Register, EngineInterface } from 'claude-code'

// The numbers Happy already tracks on the mini, on one line above the prompt, costing no tokens.
// Every figure is the database's own: latest balance per active account, and this month's
// transactions. Nothing is estimated here — a number that looks wrong is wrong in the source.
//
// ssh is slow, so the fetch never happens inside the render hook: session.start primes it and a
// one-shot timer re-arms itself after each fetch settles, so two fetches never overlap and nothing
// runs while the band is off. /money on, off, or refresh.

// Host and database paths come from userConfig: this mod reads a Happy-shaped SQLite pair
// (accounts/balances, transactions) over ssh, and nothing about that is specific to one machine.
let HOST = 'mini'
let NETWORTH_DB = '$HOME/.openclaw/data/networth.db'
let FINANCE_DB = '$HOME/.openclaw/data/finance.db'
let EF_ACCOUNT = 'UOB One'
let EF_TARGET = 30000
const REFRESH_MS = 15 * 60 * 1000
const SHOWN_KEY = 'money-band:shown'

// Markers fence each result, because the mini's shell profile wraps the output in terminal escapes
// and a naive strip of those once ate a whole account.
const script = () => `export PATH=/opt/homebrew/bin:$PATH
N="${NETWORTH_DB}"
F="${FINANCE_DB}"
printf 'NW<'
sqlite3 -separator '|' "$N" "WITH latest AS (SELECT account_id, MAX(snapshot_date) d FROM balances GROUP BY account_id), cur AS (SELECT a.type, a.is_liability, b.balance_sgd, b.snapshot_date FROM accounts a JOIN latest l ON l.account_id = a.id JOIN balances b ON b.account_id = a.id AND b.snapshot_date = l.d WHERE a.active = 1) SELECT IFNULL(SUM(CASE WHEN is_liability = 0 AND type IN ('bank','crypto','investment') THEN balance_sgd END), 0) || '|' || IFNULL(SUM(CASE WHEN is_liability = 0 AND type = 'property' THEN balance_sgd END), 0) || '|' || IFNULL(SUM(CASE WHEN is_liability = 0 AND type = 'cpf' THEN balance_sgd END), 0) || '|' || IFNULL(SUM(CASE WHEN is_liability = 1 THEN balance_sgd END), 0) || '|' || IFNULL(MAX(snapshot_date), '') FROM cur;" | tr -d '\\n'
printf '>NW\\n'
printf 'FIN<'
sqlite3 -separator '|' "$F" "SELECT IFNULL(SUM(CASE WHEN flow = 'spend' THEN amount END), 0) || '|' || COUNT(*) || '|' || IFNULL(MAX(txn_date), '') || '|' || IFNULL((SELECT ROUND(amount) || ' ' || IFNULL(merchant, '?') FROM transactions WHERE txn_date >= date('now', 'start of month') ORDER BY amount DESC LIMIT 1), '') FROM transactions WHERE txn_date >= date('now', 'start of month');" | tr -d '\\n'
printf '>FIN\\n'
printf 'EF<'
sqlite3 "$N" "SELECT IFNULL((SELECT b.balance_sgd FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.active = 1 AND instr(lower(a.name), lower('${EF_ACCOUNT.replace(/'/g, "''")}')) > 0 AND b.snapshot_date = (SELECT MAX(snapshot_date) FROM balances WHERE account_id = a.id) ORDER BY b.balance_sgd DESC LIMIT 1), '');" | tr -d '\\n'
printf '>EF\\n'`

type Money = {
  liquid: number
  property: number
  cpf: number
  debt: number
  asOf: string
  spend: number
  txns: number
  lastTxn: string
  biggest: string
  ef?: number
  at: number
}

// The name is spliced into a shell string that ssh runs on the host, so only characters that cannot
// open a subshell or close the quoting are allowed; anything else keeps the default and is logged.
export const efName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  return /^[\w .&'-]+$/.test(name) ? name : undefined
}

const net = (m: Money) => m.liquid + m.property + m.cpf - m.debt

let money: Money | undefined
let error: string | undefined
let shown = true
let timer: { cancel: () => void } | undefined
let epoch = 0
let refreshFailed = false
let efRejected: string | undefined

const num = (value: string | undefined) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const fetchMoney = async ($: EngineInterface): Promise<void> => {
  const r = await $.process.run(['ssh', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', HOST, script()], { timeoutMs: 20000 }).catch(err => {
    error = `${err}`
    return undefined
  })
  if (!r) return
  if (r.exitCode !== 0) {
    error = (r.stderr.trim().split('\n')[0] ?? `ssh ${HOST} exited ${r.exitCode}`).slice(0, 80)
    return
  }
  const between = (marker: string) => {
    const open = r.stdout.indexOf(`${marker}<`)
    const close = r.stdout.indexOf(`>${marker}`, open)
    return open === -1 || close === -1 ? undefined : r.stdout.slice(open + marker.length + 1, close).split('|')
  }
  const networth = between('NW')
  const finance = between('FIN')
  const efRaw = between('EF')?.[0] ?? ''
  if (!networth || networth.length < 5 || !finance || finance.length < 4) {
    error = 'the databases answered nothing'
    return
  }
  error = undefined
  money = {
    liquid: num(networth[0]),
    property: num(networth[1]),
    cpf: num(networth[2]),
    debt: num(networth[3]),
    asOf: networth[4] ?? '',
    spend: num(finance[0]),
    txns: Math.round(num(finance[1])),
    lastTxn: finance[2] ?? '',
    biggest: finance[3] ?? '',
    ef: efRaw === '' ? undefined : num(efRaw),
    at: await $.clock.now(),
  }
}

// Each arm takes a token; a callback whose token has moved on is stale (the band was turned off, or
// re-armed by /money, or the module was reloaded) and does nothing, so timers never fork.
const arm = ($: EngineInterface): void => {
  timer?.cancel()
  const token = ++epoch
  timer = $.clock.after(REFRESH_MS, () => {
    if (token !== epoch || !shown) return
    void refresh($, token)
  })
}

// One failed refresh is logged once and the chain goes on; a fetch that rejected is not a reason to
// stop reading for the rest of the session.
const refresh = async ($: EngineInterface, token: number): Promise<void> => {
  try {
    await fetchMoney($)
    await $.ui.invalidate('ui.render')
    refreshFailed = false
  } catch (err) {
    if (!refreshFailed) $.ui.log(`money-band: refresh failed, trying again in ${REFRESH_MS / 60000}m: ${err}`)
    refreshFailed = true
  }
  if (token === epoch && shown) arm($)
}

const disarm = (): void => {
  epoch++
  timer?.cancel()
  timer = undefined
}

const sgd = (amount: number) => {
  const abs = Math.abs(amount)
  if (abs >= 1000000) return `${amount < 0 ? '-' : ''}${(abs / 1000000).toFixed(2)}m`
  if (abs >= 1000) return `${amount < 0 ? '-' : ''}${(abs / 1000).toFixed(abs >= 100000 ? 0 : 1)}k`
  return `${amount < 0 ? '-' : ''}${Math.round(abs)}`
}

const daysSince = (date: string, now: number) => {
  const then = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(then) ? Math.floor((now - then) / 86400000) : undefined
}

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'money-band'
let disabled = false
const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === MOD)
  return disabled
}

export const register: Register = (on, options) => {
  if (typeof options.host === 'string' && options.host.trim()) HOST = options.host.trim()
  if (typeof options.networthDb === 'string' && options.networthDb.trim()) NETWORTH_DB = options.networthDb.trim()
  if (typeof options.financeDb === 'string' && options.financeDb.trim()) FINANCE_DB = options.financeDb.trim()
  const account = efName(options.efAccount)
  if (account) EF_ACCOUNT = account
  else if (typeof options.efAccount === 'string' && options.efAccount.trim()) efRejected = options.efAccount
  const target = Number(options.efTarget)
  if (Number.isFinite(target) && target > 0) EF_TARGET = target

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    if ((await $.store.get(SHOWN_KEY).catch(() => undefined)) === false) shown = false
    await $.command
      .register({
        name: 'money',
        description: 'The money line above the prompt: liquid, CPF, debt, spend this month (money-band)',
        argumentHint: '[on | off | refresh]',
        immediate: true,
      })
      .catch(err => $.ui.log(`money-band: /money not registered: ${err}`))
    if (efRejected) $.ui.log(`money-band: efAccount "${efRejected}" has characters a shell reads; using "${EF_ACCOUNT}" (letters, digits, space . & ' - only)`)
    if (!shown) return r
    // primed without blocking the session, and re-armed from each fetch from then on
    void refresh($, ++epoch)
    return r
  })

  on('command.run', { command: 'money' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      shown = false
      disarm()
      await $.store.set(SHOWN_KEY, false).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'money band off' }
    }
    if (arg === 'on' || arg === 'refresh' || arg === '') {
      shown = true
      await $.store.set(SHOWN_KEY, true).catch(() => undefined)
      $.ui.status('reading the mini…')
      await fetchMoney($)
      $.ui.status(undefined)
      arm($)
      $.ui.invalidate('ui.render')
      if (error) return { text: `money-band could not read the mini: ${error}` }
      if (!money) return { text: 'money-band got no figures back' }
      const stale = daysSince(money.asOf, money.at)
      return {
        text: [
          `net worth         S$${Math.round(net(money)).toLocaleString('en-SG')}`,
          '',
          `liquid            S$${Math.round(money.liquid).toLocaleString('en-SG')}   bank, crypto, IBKR`,
          `property          S$${Math.round(money.property).toLocaleString('en-SG')}`,
          `CPF               S$${Math.round(money.cpf).toLocaleString('en-SG')}`,
          `debt             -S$${Math.round(money.debt).toLocaleString('en-SG')}`,
          '',
          `spend this month  S$${Math.round(money.spend).toLocaleString('en-SG')} over ${money.txns} transactions`,
          money.biggest ? `largest           S$${money.biggest}` : '',
          '',
          `balances as of ${money.asOf}${stale !== undefined && stale > 30 ? ` — ${stale} days old` : ''}, last transaction ${money.lastTxn}`,
          'Read straight from networth.db and finance.db on the mini; nothing here is estimated, so a figure that looks wrong is wrong at the source.',
        ].filter(Boolean).join('\n'),
      }
    }
    return { text: `money: no such argument "${arg}" — use on, off or refresh` }
  })

  // The emergency fund's fill as a footer mode label beside `focus`: labels there are plain strings,
  // so the figure carries no colour.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (disabled || !shown || money?.ef === undefined) return next(e)
    const label = `EF ${Math.round((money.ef / EF_TARGET) * 100)}%`
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  // A render hook that throws unmounts the module and takes the whole mod with it, so a bad frame
  // falls back to the band as it was rather than costing the session its money line.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (!shown || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    try {
      const { Box, Text } = await $.ui.resolve(e)
      const rest = await next(e)

      if (!money) {
        return (
          <Box flexDirection="column">
            <Text dimColor>{error ? `money · ${HOST} unreachable: ${error}` : `money · reading ${HOST}…`}</Text>
            {rest}
          </Box>
        )
      }

      const stale = daysSince(money.asOf, money.at)
      const netText = `S$${sgd(net(money))}`
      // One string measured against the band's columns, shedding the least useful figure first,
      // because a row of separate Text nodes wraps into stacked fragments at fifty columns.
      const tail: [string, number][] = [
        ['money', 5],
        [`net ${netText}`, 0],
        [`liquid S$${sgd(money.liquid)}`, 0],
        [`cpf S$${sgd(money.cpf)}`, 4],
        [`debt S$${sgd(money.debt)}`, 3],
        [`spent this month S$${sgd(money.spend)}`, 2],
        [stale !== undefined && stale > 30 ? `· balances ${stale}d old` : `· ${money.asOf}`, 1],
      ]
      const columns = e.props.bodyColumns || 80
      const width = (list: [string, number][]) => list.reduce((n, [t]) => n + t.length, 0) + 2 * (list.length - 1)
      let kept = tail
      while (width(kept) > columns) {
        const drop = kept.filter(([, d]) => d > 0).reduce((a, b) => (a[1] < b[1] ? a : b), ['', Infinity] as [string, number])
        if (!Number.isFinite(drop[1])) break
        kept = kept.filter(x => x !== drop)
      }
      const at = kept.findIndex(([t]) => t.startsWith('net '))
      const before = kept.slice(0, at).map(([t]) => t).join('  ')
      const after = kept.slice(at + 1).map(([t]) => t).join('  ')
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end" dimColor>
            {before ? `${before}  ` : ''}
            {'net '}
            <Text bold color={net(money) >= 0 ? 'green' : 'red'}>{netText}</Text>
            {after ? `  ${after}` : ''}
          </Text>
          {rest}
        </Box>
      )
    } catch (err) {
      $.ui.log(`money-band: render failed, falling back: ${err}`)
      return next(e)
    }
  })
}
