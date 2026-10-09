const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { AsyncLocalStorage } = require('node:async_hooks')
const { performance } = require('node:perf_hooks')
const { createDatabase } = require('./database')

function createRuntime({ filename, logger = console, delayMs = 0 }) {
  const context = new AsyncLocalStorage()
  const db = createDatabase(filename, () => context.getStore()?.metrics)
  const apiPath = path.resolve(__dirname, '../cloudfunctions/api/index.js')
  const apiRequire = createRequire(apiPath)
  const virtual = apiRequire('./virtual-users')
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'local', init() {}, database: () => db,
    getWXContext: () => ({ OPENID: context.getStore()?.openid }),
  }
  const injectedRequire = name => name === 'wx-server-sdk' ? cloud : name === './virtual-users' ? {
    ...virtual,
    resolveIdentity(openid, slot) {
      return virtual.resolveIdentity(openid, slot, { VIRTUAL_TEST_ENABLED: 'true', VIRTUAL_TEST_OPENIDS: openid })
    },
  } : apiRequire(name)
  const localConsole = {
    info(message, fields) {
      if (message === 'api metrics') Object.assign(context.getStore().metrics, fields)
      else logger.info(message, fields)
    },
    error: (...args) => logger.error(...args),
  }
  // Scoped CommonJS dependency injection: shared cloud entry and rules remain untouched.
  const module = { exports: {} }
  const load = vm.runInThisContext(`(function(require, module, exports, console) {\n${fs.readFileSync(apiPath, 'utf8')}\n})`, { filename: apiPath })
  load(injectedRequire, module, module.exports, localConsole)
  let tail = Promise.resolve()
  let closed = false
  function enqueue(openid, event, injectedDelay = delayMs) {
    if (closed) return Promise.reject(new Error('Local runtime is closed'))
    const arrived = performance.now()
    const pending = tail.then(async () => {
      const started = performance.now()
      const metrics = { backend: 'local', queueMs: started - arrived, databaseMs: 0, sqlReads: 0, sqlWrites: 0, injectedDelayMs: injectedDelay }
      return context.run({ openid, metrics }, async () => {
        if (injectedDelay) await new Promise(resolve => setTimeout(resolve, injectedDelay))
        const result = await module.exports.main(event)
        metrics.serverMs = performance.now() - started
        if (event.action || result.data?.advanced || result.data?.failed) logger.info('local api metrics', metrics)
        return { ...result, timing: metrics }
      })
    })
    tail = pending.catch(() => {})
    return pending
  }
  return {
    db,
    call: (openid, event) => enqueue(openid, event),
    timer: () => enqueue(undefined, { Type: 'Timer', TriggerName: 'advanceGames' }, 0),
    read(callback) {
      if (closed) return Promise.reject(new Error('Local runtime is closed'))
      const result = tail.then(() => context.run({ metrics: null }, () => callback(db)))
      tail = result.catch(() => {})
      return result
    },
    async close() { closed = true; await tail; db.close() },
  }
}
module.exports = { createRuntime }
