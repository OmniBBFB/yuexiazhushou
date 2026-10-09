const { DatabaseSync } = require('node:sqlite')
const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')

const clone = value => value === undefined ? undefined : structuredClone(value)
const replacement = Symbol('replacement')
const lessThan = Symbol('lessThan')
const includes = Symbol('includes')
const error = message => Object.assign(new Error(message), { code: 'DATABASE_LOCAL' })

// Only the CloudBase operations used by this project's shared rules are exposed.
function createDatabase(filename, getMetrics = () => null) {
  const sqlite = new DatabaseSync(filename)
  sqlite.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS documents (
      collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
      PRIMARY KEY(collection, id)
    );
  `)
  for (const field of ['openid', 'code', 'gameId', 'ownerId', 'dueAt', 'expiresAt']) {
    sqlite.exec(`CREATE INDEX IF NOT EXISTS documents_${field} ON documents(collection, json_extract(body, '$.${field}'))`)
  }
  const changes = new EventEmitter()
  changes.setMaxListeners(0)
  let pending = null
  const command = {
    set: value => ({ [replacement]: value }),
    lt: value => ({ [lessThan]: value }),
    in: value => ({ [includes]: value }),
  }
  function execute(kind, sql, values, operation) {
    const start = performance.now()
    try { return sqlite.prepare(sql)[operation](...values) }
    finally {
      const metrics = getMetrics()
      if (metrics) {
        metrics.databaseMs = (metrics.databaseMs || 0) + performance.now() - start
        const field = kind === 'read' ? 'sqlReads' : 'sqlWrites'
        metrics[field] = (metrics[field] || 0) + 1
      }
    }
  }
  function control(sql) {
    const start = performance.now()
    try { sqlite.exec(sql) }
    finally { const metrics = getMetrics(); if (metrics) metrics.databaseMs = (metrics.databaseMs || 0) + performance.now() - start }
  }
  function notify(name, id) {
    if (pending) pending.set(`${name}:${id}`, { collection: name, id })
    else changes.emit('commit', [{ collection: name, id }])
  }
  const scalar = value => value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? Number(value) : value
  function filter(query) {
    const conditions = [], values = []
    for (const [field, value] of Object.entries(query)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) throw error('Unsupported query field')
      const expression = field === '_id' ? 'id' : `json_extract(body, '$.${field}')`
      if (value && typeof value === 'object' && includes in value) {
        const candidates = value[includes]
        if (!Array.isArray(candidates) || !candidates.length) { conditions.push('0'); continue }
        conditions.push(`EXISTS (SELECT 1 FROM json_each(${expression}) WHERE value IN (${candidates.map(() => '?').join(',')}))`)
        values.push(...candidates.map(scalar))
      } else if (value && typeof value === 'object' && lessThan in value) {
        conditions.push(`${expression} < ?`); values.push(scalar(value[lessThan]))
      } else if (value === null) conditions.push(`${expression} IS NULL`)
      else {
        if (typeof value === 'object' || value === undefined) throw error('Unsupported query value')
        conditions.push(`${expression} = ?`); values.push(scalar(value))
      }
    }
    return { clause: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', values }
  }
  function collection(name, transactional = false) {
    if (!/^[a-z_]+$/.test(name)) throw error('Invalid collection')
    return {
      doc(id) {
        if (typeof id !== 'string' || !id) throw error('Invalid document ID')
        function read() {
          const row = execute('read', 'SELECT body FROM documents WHERE collection = ? AND id = ?', [name, id], 'get')
          return row ? JSON.parse(row.body) : undefined
        }
        function write(data) {
          execute('write', 'INSERT INTO documents(collection,id,body) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body', [name, id, JSON.stringify({ ...data, _id: id })], 'run')
          notify(name, id)
        }
        return {
          async get() {
            const data = read()
            if (!data && transactional) throw new Error(`document.get:fail document with _id ${id} does not exist`)
            return { data }
          },
          async set({ data }) { write(data); return { stats: { updated: 1 } } },
          async update({ data }) {
            const previous = read()
            if (!previous) throw error('Document does not exist')
            // CloudBase merges object patches; command.set replaces the whole field.
            const merge = (old, patch) => {
              if (patch && replacement in Object(patch)) return clone(patch[replacement])
              if (patch && Object.getPrototypeOf(patch) === Object.prototype && old && Object.getPrototypeOf(old) === Object.prototype) {
                const next = { ...old }
                for (const [key, value] of Object.entries(patch)) next[key] = merge(old[key], value)
                return next
              }
              return clone(patch)
            }
            write(merge(previous, data)); return { stats: { updated: 1 } }
          },
          async remove() {
            const result = execute('write', 'DELETE FROM documents WHERE collection = ? AND id = ?', [name, id], 'run')
            if (result.changes) notify(name, id)
            return { stats: { removed: result.changes } }
          },
        }
      },
      where(query) {
        let count = 100, offset = 0
        const result = {
          limit(value) { if (!Number.isInteger(value) || value < 1) throw error('Invalid limit'); count = value; return result },
          skip(value) { if (!Number.isInteger(value) || value < 0) throw error('Invalid offset'); offset = value; return result },
          async get() {
            const { clause, values } = filter(query)
            const rows = execute('read', `SELECT body FROM documents WHERE collection = ?${clause} ORDER BY id LIMIT ? OFFSET ?`, [name, ...values, count, offset], 'all')
            return { data: rows.map(row => JSON.parse(row.body)) }
          },
          async remove() {
            const { clause, values } = filter(query)
            const rows = execute('read', `SELECT id FROM documents WHERE collection = ?${clause}`, [name, ...values], 'all')
            for (const row of rows) await collection(name, transactional).doc(row.id).remove()
            return { stats: { removed: rows.length } }
          },
        }
        return result
      },
    }
  }
  return {
    command, changes, collection,
    serverDate: () => new Date(),
    async runTransaction(callback) {
      if (pending) throw error('Concurrent or nested SQLite transaction; use the application queue')
      control('BEGIN IMMEDIATE')
      pending = new Map()
      let result, committed
      try {
        result = await callback({ collection: name => collection(name, true) })
        control('COMMIT')
        committed = [...pending.values()]
        pending = null
      } catch (failure) {
        control('ROLLBACK'); pending = null
        throw failure
      }
      if (committed.length) changes.emit('commit', committed)
      return result
    },
    close() { sqlite.close(); changes.removeAllListeners() },
  }
}
module.exports = { createDatabase }
