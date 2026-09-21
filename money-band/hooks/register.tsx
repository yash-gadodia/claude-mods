/* @jsx h */
import type { Register, EngineInterface } from 'claude-code'

// The numbers Happy already tracks on the mini, on one line above the prompt, costing no tokens.
// Every figure is the database's own: latest balance per active account, and this month's
// transactions. Nothing is estimated here — a number that looks wrong is wrong in the source.
//
// ssh is slow, so the fetch never happens inside the render hook: session.start primes it and a
// 15-minute timer refreshes it. /money on, off, or refresh.

// Host and database paths come from userConfig: this mod reads a Happy-shaped SQLite pair
// (accounts/balances, transactions) over ssh, and nothing about that is specific to one machine.
let HOST = 'mini'
let NETWORTH_DB = '$HOME/.openclaw/data/networth.db'
let FINANCE_DB = '$HOME/.openclaw/data/finance.db'
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
printf '>FIN\\n'`

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
  at: number
}

const net = (m: Money) => m.liquid + m.property + m.cpf - m.debt

let money: Money | undefined
let error: string | undefined
let shown = true
let timer: { cancel: () => void } | undefined

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
    at: await $.clock.now(),
  }
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
    if (!shown) return r
    // primed without blocking the session, and refreshed on a timer from then on
    void fetchMoney($).then(() => $.ui.invalidate('ui.render'))
    timer = $.clock.every(REFRESH_MS, () => {
      void fetchMoney($).then(() => $.ui.invalidate('ui.render'))
    })
    return r
  })

  on('command.run', { command: 'money' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      shown = false
      timer?.cancel()
      timer = undefined
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
      if (!timer) {
        timer = $.clock.every(REFRESH_MS, () => {
          void fetchMoney($).then(() => $.ui.invalidate('ui.render'))
        })
      }
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
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>money</Text>
            <Text>
              <Text dimColor>net </Text>
              <Text bold color={net(money) >= 0 ? 'green' : 'red'}>{`S$${sgd(net(money))}`}</Text>
            </Text>
            <Text>
              <Text dimColor>liquid </Text>
              <Text color="green">{`S$${sgd(money.liquid)}`}</Text>
            </Text>
            <Text>
              <Text dimColor>cpf </Text>
              <Text color="cyan">{`S$${sgd(money.cpf)}`}</Text>
            </Text>
            <Text>
              <Text dimColor>debt </Text>
              <Text color="red">{`S$${sgd(money.debt)}`}</Text>
            </Text>
            <Text>
              <Text dimColor>spent this month </Text>
              <Text bold color="yellow">{`S$${sgd(money.spend)}`}</Text>
            </Text>
            {stale !== undefined && stale > 30 ? <Text dimColor>{`· balances ${stale}d old`}</Text> : <Text dimColor>{`· ${money.asOf}`}</Text>}
          </Box>
          {rest}
        </Box>
      )
    } catch (err) {
      $.ui.log(`money-band: render failed, falling back: ${err}`)
      return next(e)
    }
  })
}
