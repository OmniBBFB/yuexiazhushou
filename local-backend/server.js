const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('./runtime')
const { resolveIdentity } = require('../cloudfunctions/api/virtual-users')

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
function sameSecret(left, right) {
  return typeof left === 'string' && crypto.timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)))
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0, parts = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > 131072) { reject(Object.assign(new Error('请求过大'), { status: 413, code: 'BODY_TOO_LARGE' })); parts = [] }
      else parts.push(chunk)
    })
    request.on('end', () => {
      if (size > 131072) return
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')) }
      catch (_) { reject(Object.assign(new Error('请求 JSON 无效'), { status: 400, code: 'BAD_JSON' })) }
    })
    request.on('error', reject)
  })
}
function createLocalServer({ filename, accessKey = 'local-development-only', delayMs = 0, watchTimeoutMs = 25000, timerIntervalMs = 1000, logger = console }) {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10000) throw new Error('delayMs must be between 0 and 10000')
  const runtime = createRuntime({ filename, logger, delayMs })
  const tokenSecret = crypto.randomBytes(32)
  const watches = new Set()
  let closing = false, timerPending = false
  let closePromise = null
  function tokenFor(openid) {
    const payload = Buffer.from(JSON.stringify({ openid, expiresAt: Date.now() + 86400000 })).toString('base64url')
    const signature = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }
  function authorize(request) {
    const raw = request.headers.authorization || ''
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : ''
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) fail(401, 'UNAUTHENTICATED', '本地登录已过期')
    const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url')
    if (!sameSecret(signature, expected)) fail(401, 'UNAUTHENTICATED', '本地登录已过期')
    let value
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) }
    catch (_) { fail(401, 'UNAUTHENTICATED', '本地登录无效') }
    if (typeof value.openid !== 'string' || !value.openid.startsWith('local:') || !(value.expiresAt > Date.now())) fail(401, 'UNAUTHENTICATED', '本地登录已过期')
    return value.openid
  }
  function reply(response, status, body) {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  function watchIdentity(openid, slot) {
    const identity = resolveIdentity(openid, slot, { VIRTUAL_TEST_ENABLED: 'true', VIRTUAL_TEST_OPENIDS: openid })
    return { userId: digest(identity.openid), openid, virtual: !!identity.testScope }
  }
  async function snapshot(identity, collection, query) {
    return runtime.read(async db => {
      const deny = () => fail(403, 'FORBIDDEN', '只能订阅自己的本地状态')
      if (!query || typeof query !== 'object' || Array.isArray(query)) deny()
      if (collection === 'room_signals') {
        if (Object.keys(query).sort().join(',') !== '_id,_openid' || query._id !== identity.userId || query._openid !== identity.openid) deny()
        const document = (await db.collection(collection).doc(identity.userId).get()).data
        return document && document._openid === identity.openid ? [document] : []
      }
      if (collection === 'room_states') {
        if (Object.keys(query).sort().join(',') !== '_id,readers' || typeof query._id !== 'string' || !Array.isArray(query.readers?.$in) || query.readers.$in.length !== 1 || query.readers.$in[0] !== identity.openid) deny()
        const user = (await db.collection('users').doc(identity.userId).get()).data
        const document = (await db.collection(collection).doc(query._id).get()).data
        return user?.currentRoomId === query._id && document?.readers.includes(identity.openid) && identity.userId in document.privateVersions ? [document] : []
      }
      if (collection === 'notes') {
        if (identity.virtual || Object.keys(query).sort().join(',') !== '_openid,gameId,ownerId' || query.ownerId !== identity.userId || query._openid !== identity.openid || typeof query.gameId !== 'string') deny()
        return (await db.collection('notes').where({ _openid: identity.openid, ownerId: identity.userId, gameId: query.gameId }).limit(100).get()).data
      }
      deny()
    })
  }
  async function watch(response, openid, body) {
    const identity = watchIdentity(openid, body.testUser)
    let finished = false, reading = false, dirty = false
    let timeout
    const cleanup = () => {
      finished = true
      clearTimeout(timeout)
      runtime.db.changes.off('commit', onCommit)
      watches.delete(cancel)
    }
    const finish = (status, value) => { if (finished) return; cleanup(); reply(response, status, value) }
    const cancel = () => finish(503, { ok: false, error: { code: 'SERVER_STOPPING', message: '本地后端正在停止' } })
    async function check() {
      if (finished) return
      if (reading) { dirty = true; return }
      reading = true
      try {
        const docs = await snapshot(identity, body.collection, body.query)
        if (finished) return
        const cursor = digest(JSON.stringify(docs))
        if (cursor !== body.cursor) finish(200, { ok: true, docs, cursor })
      } catch (error) { finish(error.status || 500, { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }) }
      finally { reading = false; if (dirty && !finished) { dirty = false; void check() } }
    }
    function onCommit(changed) {
      if (changed.some(item => item.collection === body.collection && (!body.query?._id || body.query._id === item.id)
        || body.collection === 'room_states' && item.collection === 'users' && item.id === identity.userId)) void check()
    }
    response.on('close', cleanup)
    watches.add(cancel)
    runtime.db.changes.on('commit', onCommit)
    await check()
    if (!finished) timeout = setTimeout(() => finish(200, { ok: true, docs: null, cursor: body.cursor || '' }), watchTimeoutMs)
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (closing) fail(503, 'SERVER_STOPPING', '本地后端正在停止')
      if (request.method === 'GET' && request.url === '/health') {
        reply(response, 200, { ok: true, backend: 'local', storage: 'sqlite', injectedDelayMs: delayMs }); return
      }
      if (request.method !== 'POST' || !['/session', '/api', '/watch'].includes(request.url)) fail(404, 'NOT_FOUND', '接口不存在')
      const body = await readBody(request)
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'BAD_REQUEST', '请求格式无效')
      if (request.url === '/session') {
        if (!sameSecret(body.accessKey, accessKey)) fail(401, 'UNAUTHENTICATED', '本地访问密钥不匹配')
        if (typeof body.clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.clientId)) fail(400, 'BAD_IDENTITY', '本地测试身份无效')
        reply(response, 200, { ok: true, token: tokenFor(`local:${body.clientId}`) }); return
      }
      const openid = authorize(request)
      if (request.url === '/watch') { await watch(response, openid, body); return }
      if (typeof body.action !== 'string' || !/^[a-zA-Z]{1,48}$/.test(body.action)
        || body.payload !== undefined && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload))) fail(400, 'BAD_REQUEST', '操作格式无效')
      const result = await runtime.call(openid, body)
      reply(response, 200, result)
    } catch (error) {
      reply(response, error.status || 500, { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '本地服务暂时不可用' } })
      if (!error.status) logger.error('local transport failed', { code: error.code, message: error.message })
    }
  })
  const timer = timerIntervalMs ? setInterval(() => {
    if (timerPending || closing) return
    timerPending = true
    runtime.timer().catch(error => logger.error('local timer failed', { message: error.message })).finally(() => { timerPending = false })
  }, timerIntervalMs) : null
  timer?.unref()
  return {
    server, runtime,
    async listen(port = 8787, host = '127.0.0.1') {
      if (!['127.0.0.1', '::1', 'localhost'].includes(host) && accessKey.length < 16) throw new Error('LAN binding requires an access key of at least 16 characters')
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
      return server.address()
    },
    close() {
      if (!closePromise) closePromise = (async () => {
        closing = true; clearInterval(timer)
        for (const cancel of [...watches]) cancel()
        if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections() })
        await runtime.close()
      })()
      return closePromise
    },
  }
}

if (require.main === module) {
  const filename = path.resolve(process.env.TT_LOCAL_DB || path.join(__dirname, 'data/game.sqlite'))
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const host = process.env.TT_LOCAL_HOST || '127.0.0.1'
  const port = Number(process.env.TT_LOCAL_PORT || 8787)
  const service = createLocalServer({ filename, accessKey: process.env.TT_LOCAL_ACCESS_KEY || 'local-development-only', delayMs: Number(process.env.TT_LOCAL_DELAY_MS || 0) })
  service.listen(port, host).then(() => console.info('Local backend ready', { url: `http://${host}:${port}`, database: filename, injectedDelayMs: Number(process.env.TT_LOCAL_DELAY_MS || 0) }))
    .catch(async error => { console.error(error.message); await service.close(); process.exitCode = 1 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close() })
}
module.exports = { createLocalServer }
