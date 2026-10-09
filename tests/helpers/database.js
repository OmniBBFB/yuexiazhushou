const clone = value => value === undefined ? undefined : structuredClone(value)
function database(seed = {}) {
  const state = new Map(), revisions = new Map()
  for (const [name, docs] of Object.entries(seed)) for (const doc of docs) state.set(`${name}:${doc._id}`, clone(doc))
  const metrics = { transactions: 0, commits: 0, retries: 0, reads: 0, writes: 0 }
  let failure = null, readFailure = null, beforeCommit = null
  const command = { set: value => ({ $replace: clone(value) }), lt: value => ({ $lt: value }) }
  const apply = (old, patch) => {
    const result = { ...old }
    for (const [key, value] of Object.entries(patch)) result[key] = value && value.$replace !== undefined ? clone(value.$replace) : clone(value)
    return result
  }
  const collection = (name, snapshot = state, reads, writes) => ({
    doc(id) {
      const key = `${name}:${id}`
      const read = () => {
        if (readFailure && readFailure(name, id)) throw new Error('database unavailable')
        metrics.reads++
        if (reads) reads.add(key)
        if (reads && !snapshot.has(key)) throw new Error(`document.get:fail document with _id ${id} does not exist`)
        return { data: clone(snapshot.get(key)) }
      }
      const write = (operation, data) => {
        if (failure && failure(name, id, operation)) throw new Error('injected write failure')
        metrics.writes++
        if (operation === 'remove') snapshot.delete(key)
        else if (operation === 'update') {
          if (!snapshot.has(key)) throw new Error('document missing')
          snapshot.set(key, apply(snapshot.get(key), data))
        } else snapshot.set(key, { ...clone(data), _id: id })
        if (writes) writes.add(key)
        else revisions.set(key, (revisions.get(key) || 0) + 1)
      }
      return { get: async () => read(), set: async ({ data }) => write('set', data), update: async ({ data }) => write('update', data), remove: async () => write('remove') }
    },
    where(query) {
      let limit = 100, skip = 0
      const found = () => [...snapshot.entries()].filter(([key, doc]) => key.startsWith(`${name}:`) && Object.entries(query).every(([field, value]) => value && typeof value === 'object' && '$lt' in value ? doc[field] < value.$lt : doc[field] === value)).map(([, doc]) => clone(doc))
      const result = {
        limit(value) { limit = value; return result }, skip(value) { skip = value; return result },
        async get() { if (readFailure && readFailure(name)) throw new Error('database unavailable'); metrics.reads++; return { data: found().slice(skip, skip + limit) } },
        async remove() { for (const doc of found()) await collection(name).doc(doc._id).remove() },
      }
      return result
    },
  })
  const db = {
    command, serverDate: () => new Date(), collection,
    async runTransaction(callback) {
      metrics.transactions++
      for (let attempt = 0; attempt < 4; attempt++) {
        const snapshot = new Map([...state].map(([key, value]) => [key, clone(value)]))
        const versions = new Map(revisions), reads = new Set(), writes = new Set()
        const result = await callback({ collection: name => collection(name, snapshot, reads, writes) })
        if (beforeCommit) { const hook = beforeCommit; beforeCommit = null; await hook() }
        const conflict = [...new Set([...reads, ...writes])].some(key => (versions.get(key) || 0) !== (revisions.get(key) || 0))
        if (conflict) { metrics.retries++; continue }
        for (const key of writes) {
          if (snapshot.has(key)) state.set(key, snapshot.get(key)); else state.delete(key)
          revisions.set(key, (revisions.get(key) || 0) + 1)
        }
        metrics.commits++
        return result
      }
      throw Object.assign(new Error('transaction conflict'), { code: 'TRANSACTION_CONFLICT' })
    },
  }
  return { db, metrics, docs: name => [...state.entries()].filter(([key]) => key.startsWith(`${name}:`)).map(([, doc]) => clone(doc)),
    failWrite: fn => { failure = fn }, failRead: fn => { readFailure = fn }, beforeCommit: fn => { beforeCommit = fn } }
}
module.exports = { database }
