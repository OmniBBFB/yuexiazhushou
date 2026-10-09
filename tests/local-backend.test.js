const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const { createDatabase } = require('../local-backend/database')
const { createRuntime } = require('../local-backend/runtime')
const { createLocalServer } = require('../local-backend/server')
const logger = { info() {}, error() {} }
const root = path.resolve(__dirname, '..')
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-local-build-'))
execFileSync('tsc', ['--outDir', build, '--rootDir', root], { cwd: root })
const config = { total: 6, wolves: 2, gods: 2, villagers: 2, godRoles: ['预言家', '女巫'], winMode: '屠边', interval: 1 }

test('SQLite persists documents and dates, rolls back partial writes, and notifies only committed changes', async () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-sqlite-')), 'test.sqlite')
  let db = createDatabase(filename)
  const commits = []
  db.changes.on('commit', changes => commits.push(changes))
  try {
    await db.collection('rooms').doc('r').set({ data: { settings: { a: 1, b: 2 }, createdAt: new Date('2026-01-01'), readers: ['alice'] } })
    await assert.rejects(db.runTransaction(async transaction => {
      await transaction.collection('rooms').doc('r').update({ data: { settings: db.command.set({ a: 3 }) } })
      await transaction.collection('games').doc('g').set({ data: { roomId: 'r' } })
      throw new Error('rollback')
    }), /rollback/)
    assert.equal(commits.length, 1)
    assert.deepEqual((await db.collection('rooms').doc('r').get()).data.settings, { a: 1, b: 2 })
    assert.equal((await db.collection('games').doc('g').get()).data, undefined)
    await db.runTransaction(async transaction => {
      await transaction.collection('rooms').doc('r').update({ data: { settings: db.command.set({ a: 3 }) } })
      await transaction.collection('games').doc('g').set({ data: { roomId: 'r' } })
    })
    assert.equal(commits.length, 2)
    assert.equal(commits[1].length, 2)
    assert.equal((await db.collection('rooms').where({ readers: db.command.in(['alice']), createdAt: db.command.lt(new Date('2027-01-01')) }).get()).data.length, 1)
    db.close(); db = createDatabase(filename)
    assert.deepEqual((await db.collection('rooms').doc('r').get()).data.settings, { a: 3 })
    assert.equal((await db.collection('rooms').doc('r').get()).data.createdAt, '2026-01-01T00:00:00.000Z')
    assert.equal((await db.collection('games').doc('g').get()).data.roomId, 'r')
  } finally { db.close() }
})

test('shared rules on SQLite preserve stale-version checks, idempotency, virtual separation and private notes', async () => {
  const runtime = createRuntime({ filename: ':memory:', logger })
  let counter = 0
  const call = (user, action, payload = {}, testUser) => runtime.call(`local:${user}`, { action, payload: { ...payload, requestId: `local_request_${++counter}_000000` }, testUser })
  try {
    let room = (await call('alice', 'createRoom', { config })).data
    room = (await call('bob', 'joinRoom', { code: room.code, password: '' })).data
    const simultaneous = await Promise.all([
      call('alice', 'selectSeat', { seat: 1, version: room.version }),
      call('bob', 'selectSeat', { seat: 1, version: room.version }),
    ])
    assert.equal(simultaneous.filter(result => result.ok).length, 1)
    assert.equal(simultaneous.find(result => !result.ok).error.code, 'STALE_STATE')
    room = (await call('alice', 'getRoom')).data
    room = (await call('bob', 'selectSeat', { seat: 2, version: room.version })).data
    const event = { action: 'setReady', payload: { ready: true, version: room.version, requestId: 'local_idempotent_000001' }, delivery: 'subscription' }
    const first = await runtime.call('local:alice', event), again = await runtime.call('local:alice', event)
    assert.equal(first.ok, true)
    assert.deepEqual(first.data, again.data)
    assert.equal((await call('alice', 'getRoom')).data.version, first.data.version)
    room = (await call('bob', 'setReady', { ready: true, version: first.data.version })).data
    room = (await call('alice', 'addBots', { version: room.version })).data
    room = (await call('alice', 'startGame', { version: room.version })).data
    const saved = await call('alice', 'saveNotes', { gameId: room.game.id, notes: [{ targetSeat: 2, revision: 0, text: 'private' }] })
    assert.equal(saved.ok, true)
    assert.equal((await call('alice', 'listNotes')).data[0].text, 'private')
    assert.deepEqual((await call('bob', 'listNotes')).data, [])
    const host = await call('developer', 'session', {}, 'host')
    const player = await call('developer', 'session', {}, 'player-1')
    assert.notEqual(host.data.profile.id, player.data.profile.id)
    assert.equal(host.identity.testUser, 'host')
    assert.equal((await call('developer', 'session', {}, 'invalid')).error.code, 'BAD_TEST_USER')
    const publicDoc = (await runtime.read(db => db.collection('room_states').doc(room.id).get())).data
    assert.equal(publicDoc.state.game.myRole, undefined)
    assert.ok(first.timing.sqlReads > 0)
    assert.ok(first.timing.sqlWrites > 0)
    assert.ok(first.timing.serverMs >= first.timing.databaseMs)
  } finally { await runtime.close() }
})

async function service(t, options = {}) {
  const server = createLocalServer({ filename: ':memory:', logger, timerIntervalMs: 0, watchTimeoutMs: 100, ...options })
  const address = await server.listen(0)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${address.port}`
  async function post(route, body, token = '') {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    return { status: response.status, ...await response.json() }
  }
  async function login(user) { return (await post('/session', { clientId: user, accessKey: 'local-development-only' })).token }
  let counter = 0
  const call = (token, action, payload = {}, extras = {}) => post('/api', { action, payload: { ...payload, requestId: `http_request_${++counter}_00000` }, ...extras }, token)
  return { server, url, post, login, call }
}

test('HTTP auth and commit-driven watches isolate private snapshots and renew without game queries', async t => {
  const s = await service(t)
  assert.equal((await s.post('/api', { action: 'session' })).status, 401)
  assert.equal((await s.post('/session', { clientId: 'alice', accessKey: 'wrong' })).status, 401)
  const alice = await s.login('alice'), bob = await s.login('bob')
  let room = (await s.call(alice, 'createRoom', { config })).data
  room = (await s.call(bob, 'joinRoom', { code: room.code })).data
  const identity = (await s.call(alice, 'syncIdentity')).data
  await s.call(alice, 'subscribeRoom')
  const publicWatch = { collection: 'room_states', query: { _id: room.id, readers: { $in: [identity.openid] } } }
  const initial = await s.post('/watch', publicWatch, alice)
  assert.equal(initial.docs[0].state.version, room.version)
  const denied = await s.post('/watch', { collection: 'room_signals', query: { _id: identity.userId, _openid: identity.openid } }, bob)
  assert.equal(denied.status, 403)
  assert.equal((await s.post('/watch', { collection: 'games', query: {} }, alice)).status, 403)
  const changed = s.post('/watch', { ...publicWatch, cursor: initial.cursor }, alice)
  const ack = await s.call(alice, 'selectSeat', { seat: 1, version: room.version }, { delivery: 'subscription' })
  const pushed = await changed
  assert.equal(ack.data.accepted, true)
  assert.equal(pushed.docs[0].state.version, ack.data.version)
  const heartbeat = await s.post('/watch', { ...publicWatch, cursor: pushed.cursor }, alice)
  assert.equal(heartbeat.docs, null)
  assert.equal(heartbeat.cursor, pushed.cursor)
  const afterHeartbeat = (await s.server.runtime.read(db => db.collection('rooms').doc(room.id).get())).data
  assert.equal(afterHeartbeat.version, ack.data.version)
  const spoof = await s.post('/api', { Type: 'Timer', TriggerName: 'advanceGames' }, alice)
  assert.equal(spoof.status, 400)
})

test('injected backend delay is measured separately from SQL and causes observable queueing', async () => {
  const runtime = createRuntime({ filename: ':memory:', logger, delayMs: 40 })
  try {
    const [first, second] = await Promise.all([
      runtime.call('local:delay', { action: 'session', traceId: 'delay_1' }),
      runtime.call('local:delay', { action: 'session', traceId: 'delay_2' }),
    ])
    assert.equal(first.timing.injectedDelayMs, 40)
    assert.ok(first.timing.serverMs >= 35)
    assert.ok(second.timing.queueMs >= 35)
    assert.ok(first.timing.databaseMs < first.timing.serverMs)
    assert.equal(first.timing.requestId, 'delay_1')
    assert.equal(second.timing.requestId, 'delay_2')
  } finally { await runtime.close() }
})

test('persisted due tasks resume after restart and advance without client requests', async () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-task-restart-')), 'game.sqlite')
  let runtime = createRuntime({ filename, logger })
  const id = require('node:crypto').createHash('sha256').update('local:timer').digest('hex')
  const members = [{ userId: id, openid: 'local:timer', authOpenid: 'local:timer', seat: 1, nickname: 'timer', alive: true, isBot: false }]
  try {
    await runtime.read(async db => {
      await db.collection('users').doc(id).set({ data: { openid: 'local:timer', authOpenid: 'local:timer', nickname: 'timer', currentRoomId: 'r' } })
      await db.collection('rooms').doc('r').set({ data: { ownerId: id, version: 1, status: 'PLAYING', gameId: 'g', config, members } })
      await db.collection('games').doc('g').set({ data: { day: 1, phase: 'NIGHT', nightStage: 'SEER', stageReadyAt: Date.now() - 1000, night: { cue: 'OPEN' }, confirmedUserIds: [], actions: {}, roles: { [id]: { role: '预言家', alive: true, abilities: {} } }, dayState: {}, publicResult: [] } })
      await db.collection('game_tasks').doc('r').set({ data: { roomId: 'r', gameId: 'g', dueAt: Date.now() - 1000 } })
    })
    await runtime.close(); runtime = createRuntime({ filename, logger })
    const result = await runtime.timer()
    assert.equal(result.ok, true)
    assert.equal(result.data.advanced, 1)
    const game = (await runtime.read(db => db.collection('games').doc('g').get())).data
    assert.equal(game.night.cue, 'ACTION')
    const publicState = (await runtime.read(db => db.collection('room_states').doc('r').get())).data
    assert.equal(publicState.state.game.nightCue, 'ACTION')
  } finally { await runtime.close() }
})

function clientBackend(s, mode = 'local', clientId = 'client') {
  const records = [], requests = [], tasks = []
  let slot = ''
  const context = {
    exports: {}, Promise,
    require: name => name.includes('config/backend') ? { backendConfig: { mode, local: { baseUrl: s.url, accessKey: 'local-development-only', clientId } } }
      : name.includes('telemetry') ? { diagnostic: (event, fields) => records.push({ event, ...fields }) }
        : { virtualUser: () => slot },
    wx: {
      request(options) {
        const controller = new AbortController()
        const task = { abort: () => controller.abort() }
        tasks.push(task); requests.push(options.url)
        // Do not reuse Node's pooled sockets across the intentional server restart.
        fetch(options.url, { method: options.method, headers: { ...options.header, Connection: 'close' }, body: JSON.stringify(options.data), signal: controller.signal })
          .then(async response => options.success({ statusCode: response.status, data: await response.json() })).catch(options.fail)
        return task
      },
      cloud: { callFunction: options => Promise.resolve({ result: { ok: true, data: options.data } }), database: () => 'original-cloud-database' },
    },
  }
  vm.runInNewContext(fs.readFileSync(path.join(build, 'miniprogram/services/backend.js'), 'utf8'), context)
  return { ...context.exports, records, requests, tasks, select: value => { slot = value } }
}

test('client selector keeps cloud transport intact and local transport logs timings and cancels watches', async t => {
  const s = await service(t)
  const cloud = clientBackend(s, 'cloud')
  assert.equal(cloud.backendDatabase(), 'original-cloud-database')
  assert.equal((await cloud.callBackend({ action: 'session' })).result.data.action, 'session')
  assert.equal(cloud.requests.length, 0)
  const local = clientBackend(s)
  const session = (await local.callBackend({ action: 'session', traceId: 'client_trace' })).result
  assert.equal(session.ok, true)
  assert.equal(local.records[0].requestId, 'client_trace')
  const identity = (await local.callBackend({ action: 'syncIdentity' })).result.data
  let receive
  const firstSnapshot = new Promise(resolve => { receive = resolve })
  const errors = []
  const watcher = local.backendDatabase().collection('room_signals').where({ _openid: identity.openid, _id: identity.userId }).watch({ onChange: receive, onError: error => errors.push(error) })
  await firstSnapshot
  await watcher.close()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(errors.length, 0)
  assert.equal(local.requests.filter(url => url.endsWith('/session')).length, 1)
})

test('local room sync merges committed public/private projections and clears state on dissolution', async t => {
  const s = await service(t, { watchTimeoutMs: 1000 })
  const local = clientBackend(s)
  let counter = 0
  const call = async (action, payload = {}) => {
    const result = (await local.callBackend({ action, payload: { ...payload, requestId: `sync_request_${++counter}_00000` } })).result
    assert.equal(result.ok, true, result.error?.message)
    return result.data
  }
  let room = await call('createRoom', { config })
  room = await call('selectSeat', { seat: 1, version: room.version })
  room = await call('setReady', { ready: true, version: room.version })
  room = await call('addBots', { version: room.version })
  room = await call('startGame', { version: room.version })
  let initial, departed
  const received = new Promise(resolve => { initial = resolve })
  const cleared = new Promise(resolve => { departed = resolve })
  const context = {
    exports: {}, Date, Math, setTimeout, clearTimeout,
    require: name => name.endsWith('/backend') ? local : name.includes('api/client') ? { api: { syncIdentity: () => call('syncIdentity'), subscribeRoom: () => call('subscribeRoom') } }
      : name.includes('virtual-users') ? { identityGeneration: () => 0 }
        : { diagnostic() {}, stateReceived() {}, subscriptionError: () => ({}), recordSubscriptionError() {} },
  }
  vm.runInNewContext(fs.readFileSync(path.join(build, 'miniprogram/services/room-sync.js'), 'utf8'), context)
  const stop = context.exports.watchRoom(() => assert.fail('Unexpected fallback query'), () => {}, () => room, value => { if (value) initial(value); else departed() })
  t.after(stop)
  const snapshot = await received
  assert.equal(snapshot.id, room.id)
  assert.equal(snapshot.version, room.version)
  assert.equal(snapshot.game.myRole.role, room.game.myRole.role)
  await call('dissolveRoom')
  await cleared
  stop()
})

test('local client renews credentials after server restart and preserves its stored identity', async t => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-login-restart-')), 'game.sqlite')
  const first = await service(t, { filename })
  const local = clientBackend(first)
  const before = (await local.callBackend({ action: 'session' })).result.data.profile.id
  const port = first.server.server.address().port
  await first.server.close()
  const restarted = createLocalServer({ filename, logger, timerIntervalMs: 0 })
  t.after(() => restarted.close())
  await restarted.listen(port)
  const after = (await local.callBackend({ action: 'session' })).result.data.profile.id
  assert.equal(after, before)
  assert.equal(local.requests.filter(url => url.endsWith('/session')).length, 2)
})

test('HTTP note watches reject other owners and deliver only the signed-in player notes', async t => {
  const s = await service(t)
  const alice = await s.login('alice'), bob = await s.login('bob')
  let room = (await s.call(alice, 'createRoom', { config })).data
  room = (await s.call(bob, 'joinRoom', { code: room.code })).data
  room = (await s.call(alice, 'selectSeat', { seat: 1, version: room.version })).data
  room = (await s.call(bob, 'selectSeat', { seat: 2, version: room.version })).data
  room = (await s.call(alice, 'setReady', { ready: true, version: room.version })).data
  room = (await s.call(bob, 'setReady', { ready: true, version: room.version })).data
  room = (await s.call(alice, 'addBots', { version: room.version })).data
  room = (await s.call(alice, 'startGame', { version: room.version })).data
  const identity = (await s.call(alice, 'syncIdentity')).data
  const query = { _openid: identity.openid, ownerId: identity.userId, gameId: room.game.id }
  const initial = await s.post('/watch', { collection: 'notes', query }, alice)
  assert.deepEqual(initial.docs, [])
  assert.equal((await s.post('/watch', { collection: 'notes', query }, bob)).status, 403)
  const pending = s.post('/watch', { collection: 'notes', query, cursor: initial.cursor }, alice)
  const saved = await s.call(alice, 'saveNotes', { gameId: room.game.id, notes: [{ targetSeat: 2, revision: 0, text: 'only alice' }] })
  assert.equal(saved.ok, true)
  assert.equal((await pending).docs[0].text, 'only alice')
  assert.deepEqual((await s.call(bob, 'listNotes')).data, [])
})

test('local wx request failures preserve errMsg for the page and identify the failing endpoint', async () => {
  const records = []
  const context = {
    exports: {}, Promise,
    require: name => name.includes('config/backend') ? { backendConfig: { mode: 'local', local: { baseUrl: 'http://127.0.0.1:8787', accessKey: 'test', clientId: 'test' } } }
      : name.includes('telemetry') ? { diagnostic: (event, fields) => records.push({ event, ...fields }) }
        : { virtualUser: () => '' },
    wx: { request(options) { options.fail({ errMsg: 'request:fail net::ERR_CONNECTION_REFUSED' }); return { abort() {} } } },
  }
  vm.runInNewContext(fs.readFileSync(path.join(build, 'miniprogram/services/backend.js'), 'utf8'), context)
  await assert.rejects(context.exports.callBackend({ action: 'createRoom', traceId: 'trace_failed' }), /ERR_CONNECTION_REFUSED/)
  assert.equal(records[0].event, 'local_transport_error')
  assert.equal(records[0].path, '/session')
  assert.equal(records[0].errorCode, 'LOCAL_TRANSPORT_ERROR')
  assert.equal(JSON.stringify(records).includes('accessKey'), false)
  // A failed login must not remain cached and block the next request.
  await assert.rejects(context.exports.callBackend({ action: 'createRoom' }), /ERR_CONNECTION_REFUSED/)
  assert.equal(records.length, 2)
})
