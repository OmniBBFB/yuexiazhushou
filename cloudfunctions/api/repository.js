async function measure(metrics, phase, run) {
  if (!metrics) return run()
  const startedAt = Date.now()
  try { return await run() }
  finally { metrics[phase] = (metrics[phase] || 0) + Math.max(0, Date.now() - startedAt) }
}
// Each invocation owns its store. Reads complete before any writes are sent,
// and every queued write uses the same CloudBase transaction handle.
function transactionStore(transaction, database, metrics) {
  const reads = new Map(), writes = [], overlay = new Map(), replacements = new WeakMap()
  const store = {
    isTransaction: true,
    command: { ...database.command, set(value) { const operation = database.command.set(value); replacements.set(operation, value); return operation } },
    beforeFlush: null,
    snapshot(name, id) { return clone(overlay.has(`${name}:${id}`) ? overlay.get(`${name}:${id}`) : (reads.get(`${name}:${id}`) || {}).data) },
    serverDate: (...args) => database.serverDate(...args),
    runTransaction: callback => callback(store),
    collection(name) {
      return { doc(id) {
        const ref = transaction.collection(name).doc(id)
        const key = `${name}:${id}`
        return {
          async get() {
            if (!reads.has(key)) {
              if (metrics) metrics.transactionReads++
              try {
                reads.set(key, assertResult(await measure(metrics, 'databaseReadMs', () => ref.get())))
              } catch (error) {
                // wx-server-sdk throws for an absent transactional document.
                // Match only this document's exact error; other failures must propagate.
                const message = error && error.message || error
                if (message !== `document.get:fail document with _id ${id} does not exist`
                  && message !== `document with _id ${id} does not exist`) throw error
                reads.set(key, { data: null })
              }
            }
            // Rules are allowed to mutate their working state, never the cached snapshot.
            const result = reads.get(key)
            return { ...result, data: overlay.has(key) ? clone(overlay.get(key)) : result.data ? clone(result.data) : result.data }
          },
          async update(options) {
            const next = { ...(overlay.has(key) ? overlay.get(key) : (reads.get(key) || {}).data) }
            for (const [field, value] of Object.entries(options.data)) next[field] = clone(value && replacements.has(value) ? replacements.get(value) : value)
            overlay.set(key, next)
            writes.push(() => ref.update(options))
          },
          async set({ data }) {
            const { _id, ...document } = data
            overlay.set(key, { ...document, _id: id })
            writes.push(() => ref.set({ data: document }))
          },
          async remove() { overlay.set(key, null); writes.push(() => ref.remove()) },
        }
      } }
    },
    async flush() { if (store.beforeFlush) { const prepare = store.beforeFlush; store.beforeFlush = null; await measure(metrics, 'snapshotPrepareMs', prepare) } for (const write of writes) { if (metrics) metrics.transactionWrites++; assertResult(await measure(metrics, 'databaseWriteMs', write)) } },
  }
  return store
}
async function runInTransaction(database, callback, metrics) {
  if (database.isTransaction) return callback(database)
  return measure(metrics, 'transactionMs', () => database.runTransaction(async transaction => measure(metrics, 'transactionCallbackMs', async () => {
    if (metrics) metrics.transactionAttempts++
    const store = transactionStore(transaction, database, metrics)
    const result = await callback(store)
    await store.flush()
    return result
  })))
}
function assertResult(result) {
  if (result && result.code) throw Object.assign(new Error(result.message || '数据库请求失败'), { code: result.code })
  return result
}
function clone(value) {
  if (value instanceof Date) return new Date(value)
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') {
    // Preserve SDK values (e.g. server dates) instead of serializing them.
    if (Object.prototype.toString.call(value) !== '[object Object]' || value.constructor && value.constructor.name !== 'Object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  }
  return value
}
function trackChanges(value) {
  let dirty = false
  const proxies = new WeakMap(), originals = new WeakMap()
  const unwrap = next => {
    if (!next || typeof next !== 'object') return next
    if (originals.has(next)) return originals.get(next)
    if (Array.isArray(next) || Object.prototype.toString.call(next) === '[object Object]') {
      for (const key of Object.keys(next)) next[key] = unwrap(next[key])
    }
    return next
  }
  const wrap = target => {
    if (!target || typeof target !== 'object' || Object.prototype.toString.call(target) !== '[object Object]' && !Array.isArray(target)) return target
    if (proxies.has(target)) return proxies.get(target)
    const proxy = new Proxy(target, {
      get(object, key) { return wrap(Reflect.get(object, key)) },
      set(object, key, next) {
        next = unwrap(next)
        if (!Object.is(object[key], next)) dirty = true
        return Reflect.set(object, key, next)
      },
      deleteProperty(object, key) { if (key in object) dirty = true; return Reflect.deleteProperty(object, key) },
    })
    proxies.set(target, proxy); originals.set(proxy, target)
    return proxy
  }
  return { value: wrap(value), changed: () => dirty }
}
module.exports = { measure, transactionStore, trackChanges, assertResult, runInTransaction }
