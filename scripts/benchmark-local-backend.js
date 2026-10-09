const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { execFile } = require('node:child_process')

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const baseUrl = argument('url', 'http://127.0.0.1:8787').replace(/\/$/, '')
const samples = Number(argument('samples', '30'))
const warmup = Number(argument('warmup', '5'))
const label = argument('label', 'local')
const output = argument('output', path.resolve(__dirname, `../local-backend/data/benchmark-${Date.now()}.json`))
const clientId = `benchmark-${crypto.randomBytes(8).toString('hex')}`
const config = { total: 6, wolves: 2, gods: 2, villagers: 2, godRoles: ['预言家', '女巫'], winMode: '屠边', interval: 1 }
let token = '', sequence = 0
async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(`${result.error?.code || response.status}: ${result.error?.message || 'Invalid response'}`)
  return result
}
function call(action, payload = {}, delivery) {
  const requestId = `benchmark_${Date.now()}_${++sequence}`
  return post('/api', { action, payload: { ...payload, requestId }, traceId: requestId, ...(delivery ? { delivery } : {}) })
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3))
}
async function main() {
  if (!Number.isInteger(samples) || samples < 1 || samples > 10000 || !Number.isInteger(warmup) || warmup < 0 || warmup > 1000) throw new Error('Invalid --samples or --warmup')
  const health = await fetch(`${baseUrl}/health`).then(response => response.json())
  token = (await post('/session', { accessKey: process.env.TT_LOCAL_ACCESS_KEY || 'local-development-only', clientId })).token
  let created = false
  try {
    let room = (await call('createRoom', { config })).data
    created = true
    room = (await call('selectSeat', { seat: 1, version: room.version })).data
    room = (await call('addBots', { version: room.version })).data
    const identity = (await call('syncIdentity')).data
    await call('subscribeRoom')
    const watch = { collection: 'room_states', query: { _id: room.id, readers: { $in: [identity.openid] } } }
    let cursor = (await post('/watch', watch)).cursor
    const records = []
    for (let index = 0; index < samples + warmup; index++) {
      const started = performance.now()
      const pushed = post('/watch', { ...watch, cursor }).then(result => ({ result, stateReceivedMs: performance.now() - started }))
      // Handle a transport failure even when the command fails before awaiting the push.
      void pushed.catch(() => {})
      const response = await call('rotateSeats', { version: room.version }, 'subscription')
      const roundTripMs = performance.now() - started
      const update = await pushed
      if (!update.result.docs?.[0] || update.result.docs[0].state.version !== response.data.version) throw new Error('Committed state did not match command acknowledgement')
      cursor = update.result.cursor
      room.version = response.data.version
      if (index >= warmup) records.push({ requestId: response.data.requestId, roundTripMs, stateReceivedMs: update.stateReceivedMs, ...response.timing })
    }
    const summary = {}
    for (const field of ['roundTripMs', 'stateReceivedMs', 'queueMs', 'serverMs', 'databaseMs']) {
      const values = records.map(record => record[field])
      summary[field] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Number(Math.max(...values).toFixed(3)) }
    }
    const report = { label, at: new Date().toISOString(), baseUrl, samples, warmup, operation: 'rotateSeats', players: 6, injectedDelayMs: health.injectedDelayMs, summary, records }
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.table(summary)
    console.info('Benchmark saved', { label, injectedDelayMs: health.injectedDelayMs, output: path.resolve(output) })
  } finally { if (created) await call('dissolveRoom') }
}
async function suite() {
  const { createLocalServer } = require('../local-backend/server')
  const directory = path.resolve(argument('directory', `local-backend/data/experiment-${Date.now()}`))
  fs.mkdirSync(directory, { recursive: true })
  const comparison = []
  for (const delayMs of [0, 100, 300, 1000]) {
    const service = createLocalServer({ filename: path.join(directory, `delay-${delayMs}.sqlite`), accessKey: process.env.TT_LOCAL_ACCESS_KEY || 'local-development-only', delayMs, logger: { info() {}, error: (...args) => console.error(...args) } })
    try {
      const address = await service.listen(0)
      const report = path.join(directory, `delay-${delayMs}.json`)
      console.info(`Sampling injected delay ${delayMs}ms`)
      await new Promise((resolve, reject) => {
        execFile(process.execPath, [__filename, '--url', `http://127.0.0.1:${address.port}`, '--samples', String(samples), '--warmup', String(warmup), '--label', `delay-${delayMs}`, '--output', report], { timeout: (samples + warmup + 15) * (delayMs + 1000) }, (error, stdout, stderr) => {
          if (stdout) process.stdout.write(stdout)
          if (stderr) process.stderr.write(stderr)
          if (error) reject(error); else resolve()
        })
      })
      const result = JSON.parse(fs.readFileSync(report, 'utf8'))
      comparison.push({ delayMs, samples, serverP95Ms: result.summary.serverMs.p95, sqlP95Ms: result.summary.databaseMs.p95, roundTripP95Ms: result.summary.roundTripMs.p95, stateReceivedP95Ms: result.summary.stateReceivedMs.p95 })
    } finally { await service.close() }
  }
  fs.writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n')
  console.table(comparison)
  console.info('Experiment saved', { directory })
}
if (require.main === module) (process.argv.includes('--suite') ? suite() : main()).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { percentile }
