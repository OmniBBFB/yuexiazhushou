const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { cloudBackend } = require('./helpers/client-backend')
const { database } = require('./helpers/database')
const apiRoot = path.resolve(__dirname, '../cloudfunctions/api')
const root = path.resolve(__dirname, '..')
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-subscriptions-'))
execFileSync('tsc', ['--outDir', build, '--rootDir', root], { cwd: root })
function fixture(waiting = false) {
  const members = ['a', 'b', 'c'].map((id, i) => ({ userId: id, openid: id, authOpenid: id, nickname: id, seat: i + 1, ready: false, alive: true, roleConfirmed: false, isBot: false }))
  return {
    users: members.map(item => ({ _id: item.userId, openid: item.openid, authOpenid: item.openid, currentRoomId: 'r', nickname: item.nickname })),
    rooms: [{ _id: 'r', code: '123456', ownerId: 'a', version: 1, status: waiting ? 'WAITING' : 'PLAYING', gameId: waiting ? '' : 'g', config: { total: 4, interval: 1 }, members }],
    games: waiting ? [] : [{ _id: 'g', roomId: 'r', day: 1, phase: 'NIGHT', nightStage: 'SEER', stageReadyAt: 0, confirmedUserIds: [], actions: {}, night: { cue: 'ACTION' }, dayState: {}, publicResult: [], roles: { a: { role: '狼人', alive: true, abilities: {} }, b: { role: '预言家', alive: true, abilities: {} }, c: { role: '村民', alive: true, abilities: {} } } }],
  }
}
function server(seed) {
  const memory = database(seed)
  let clock = Date.now(), openid = 'a'
  const context = { exports: {}, Date: class extends Date { static now() { return clock } }, console: { error() {}, info() {} },
    require: name => name === 'wx-server-sdk' ? { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => memory.db, getWXContext: () => ({ OPENID: openid }) } : name.startsWith('./') ? require(path.join(apiRoot, name)) : require(name) }
  const businessRequire = context.require
  context.require = name => name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(apiRoot, 'index.js'), 'utf8'), context)
  return { ...memory, context, call: (action, payload = {}, user = 'a') => context.dispatch(action, payload, user),
    advance: ms => { clock += ms }, now: () => clock,
    timer: () => { openid = undefined; return context.exports.main({ Type: 'Timer', TriggerName: 'advanceGames' }) },
    main: (event, user = 'a') => { openid = user; return context.exports.main(event) } }
}

test('bootstrap publishes public and private projections with matching references, excluding all secret fields', async () => {
  const s = server(fixture())
  await s.call('subscribeRoom', {}, 'b')
  const publicDoc = s.docs('room_states')[0], privateDocs = s.docs('room_signals')
  assert.deepEqual(publicDoc.readers.sort(), ['a', 'b', 'c'])
  assert.equal(publicDoc.state.game.myRole, undefined)
  assert.equal(publicDoc.state.game.myAction, undefined)
  assert.equal(publicDoc.state.game.confirmationRequired, undefined)
  assert.equal(JSON.stringify(publicDoc).includes('预言家'), false)
  const mine = privateDocs.find(doc => doc._id === 'b')
  assert.equal(mine._openid, 'b')
  assert.equal(mine.state.game.myRole.role, '预言家')
  assert.equal(publicDoc.privateVersions.b, mine.revision)
  assert.equal(privateDocs.find(doc => doc._id === 'c').state.game.myAction, undefined)
})

test('seer results publish from queued game writes, are private, and do not notify unchanged players', async () => {
  const s = server(fixture())
  await s.call('subscribeRoom', {}, 'b')
  const initial = s.docs('room_signals'), before = s.docs('room_states')[0]
  await s.call('submitNightAction', { version: 1, targetSeat: 1 }, 'b')
  const publicDoc = s.docs('room_states')[0], privateDocs = s.docs('room_signals')
  const mine = privateDocs.find(doc => doc._id === 'b')
  assert.equal(mine.state.game.myAction.result, '狼人阵营')
  assert.equal(mine.state.game.myAction.submitted, true)
  assert.equal(publicDoc.state.version, 2)
  assert.equal(JSON.stringify(publicDoc).includes('狼人阵营'), false)
  assert.ok(publicDoc.privateVersions.b > before.privateVersions.b)
  for (const id of ['a', 'c']) assert.deepEqual(privateDocs.find(doc => doc._id === id), initial.find(doc => doc._id === id))
})

test('public-only seat changes avoid per-player writes after bootstrap', async () => {
  const s = server(fixture(true))
  await s.call('subscribeRoom')
  const before = s.docs('room_signals'), writes = s.metrics.writes
  await s.call('selectSeat', { version: 1, seat: 4 }, 'b')
  assert.deepEqual(s.docs('room_signals'), before)
  assert.equal(s.docs('room_states')[0].state.members.find(member => member.userId === 'b').seat, 4)
  assert.equal(s.metrics.writes - writes, 4) // aggregate, public snapshot, metadata, task cleanup
})

test('snapshot and private-state failures roll back game, room, receipts and published states together', async () => {
  for (const collection of ['room_states', 'room_signals', 'game_tasks']) {
    const s = server(fixture())
    await s.call('subscribeRoom')
    const initial = Object.fromEntries(['rooms', 'games', 'room_states', 'room_signals'].map(name => [name, s.docs(name)]))
    s.failWrite(name => name === collection)
    await assert.rejects(s.call('submitNightAction', { version: 1, targetSeat: 1, requestId: 'subscription_atomic_001' }, 'b'))
    for (const [name, docs] of Object.entries(initial)) assert.deepEqual(s.docs(name), docs)
    assert.equal(s.docs('command_receipts').length, 0)
  }
})

test('exit revokes public access and clears personal state; dissolution clears subscriptions and tasks', async () => {
  const s = server(fixture(true))
  await s.call('subscribeRoom')
  await s.call('exitRoom', {}, 'b')
  assert.deepEqual(s.docs('room_states')[0].readers.sort(), ['a', 'c'])
  const departed = s.docs('room_signals').find(doc => doc._id === 'b')
  assert.equal(departed.roomId, '')
  assert.equal(departed.state, null)
  await s.call('exitRoom', {}, 'a')
  assert.equal(s.docs('room_states').length, 0)
  assert.equal(s.docs('game_tasks').length, 0)
  assert.ok(s.docs('room_signals').every(doc => doc.roomId === '' && doc.state === null))
})

test('timer advances night cues without a device query and schedules the next deadline', async () => {
  const seed = fixture(), s = server(seed)
  const game = s.docs('games')[0]
  game.night.cue = 'OPEN'; game.stageReadyAt = s.now() + 1000
  await s.db.collection('games').doc('g').set({ data: game })
  await s.call('subscribeRoom')
  assert.equal(s.docs('game_tasks')[0].dueAt, game.stageReadyAt)
  s.advance(1001)
  const result = await s.timer()
  assert.equal(result.ok, true)
  assert.equal(result.data.advanced, 1)
  assert.equal(s.docs('games')[0].night.cue, 'ACTION')
  assert.equal(s.docs('room_states')[0].state.game.nightCue, 'ACTION')
  assert.ok(s.docs('game_tasks')[0].dueAt > s.now())
})

test('an old deadline cannot end an extended speech; repeated timers do not advance twice', async () => {
  const seed = fixture(), s = server(seed), game = s.docs('games')[0]
  game.phase = 'DAY'; game.day = 2; game.firstNightRevealed = true
  game.dayState = { stage: 'SPEECH', speakerSeat: 2, speechQueue: [2, 3], speechDeadline: s.now() + 1000, direction: 'ASC' }
  await s.db.collection('games').doc('g').set({ data: game })
  await s.call('subscribeRoom')
  await s.call('extendSpeech', { version: 1 }, 'b')
  assert.equal(s.docs('game_tasks')[0].dueAt, game.dayState.speechDeadline + 30000)
  s.advance(1001); await s.timer()
  assert.equal(s.docs('games')[0].dayState.speakerSeat, 2)
  s.advance(30000)
  await Promise.all([s.timer(), s.timer()])
  assert.equal(s.docs('games')[0].dayState.speakerSeat, 3)
  assert.equal(s.docs('room_states')[0].state.game.dayView.speakerSeat, 3)
})

test('clients cannot spoof the internal timer and upgraded commands return small replayable acknowledgements', async () => {
  const s = server(fixture(true))
  const spoofed = await s.main({ Type: 'Timer', TriggerName: 'advanceGames' })
  assert.equal(spoofed.ok, false)
  const event = { action: 'selectSeat', delivery: 'subscription', payload: { version: 1, seat: 4, requestId: 'subscription_ack_00001' } }
  const response = await s.main(event, 'b')
  assert.equal(response.ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), { accepted: true, requestId: event.payload.requestId, roomId: 'r', version: 2 })
  assert.deepEqual(JSON.parse(JSON.stringify((await s.main(event, 'b')).data)), JSON.parse(JSON.stringify(response.data)))
  assert.equal(s.docs('rooms')[0].version, 2)
})

test('private note documents use real ownership and revisions', async () => {
  const s = server(fixture())
  await s.call('saveNotes', { gameId: 'g', notes: [{ targetSeat: 1, revision: 0, text: 'private note' }] }, 'b')
  const note = s.docs('notes')[0]
  assert.equal(note._openid, 'b'); assert.equal(note.ownerId, 'b'); assert.equal(note.revision, 1)
})

function client(publicError) {
  const diagnostics = [], delays = []
  const watchers = new Map(), received = [], statuses = [], queries = [], retries = [], closed = []
  let generation = 0, bootstrap = 0
  const context = { exports: {}, Date, Math,
    setTimeout: (fn, ms) => { delays.push(ms); retries.push(fn); return retries.length }, clearTimeout() {},
    require: name => name.includes('virtual-users') ? { identityGeneration: () => generation } : { api: { syncIdentity: async () => ({ userId: 'b', openid: 'b' }), subscribeRoom: async () => { bootstrap++; return { id: 'r' } } } },
    wx: { cloud: { database: () => ({ command: { in: value => ({ $in: value }) }, collection: name => ({ where: query => {
      queries.push({ name, query }); return { watch: options => { if (name === 'room_states' && publicError) throw publicError; watchers.set(name, options); return { close: async () => { closed.push(name) } } } }
    } }) }) } },
  }
  const businessRequire = context.require
  context.require = name => name.endsWith('/backend') ? cloudBackend(build, context.wx) : name.includes('telemetry') ? { ...require(path.join(build, 'miniprogram/services/telemetry.js')), diagnostic: (event, fields) => diagnostics.push({ event, ...fields }) } : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/room-sync.js'), 'utf8'), context)
  let refreshed = 0
  const stop = context.exports.watchRoom(() => refreshed++, value => statuses.push(value), () => null, room => received.push(room))
  return { diagnostics, delays, watchers, received, statuses, queries, retries, closed, stop, switchIdentity: () => generation++, bootstrap: () => bootstrap, refreshed: () => refreshed }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const personal = (revision, role = '预言家') => ({ _id: 'b', protocol: 2, roomId: 'r', revision, state: { game: { myRole: { role }, myConfirmed: true, dayView: { submitted: true } } } })
const publicDoc = (revision, privateRevision) => ({ _id: 'r', roomId: 'r', revision, privateVersions: { b: privateRevision }, state: { id: 'r', version: revision, members: [], broadcast: { version: 0 }, game: { id: 'g', phase: 'DAY', dayView: { stage: 'SHERIFF_VOTE' } } } })

test('subscriptions wait for matching private versions, tolerate either order and ignore duplicates and old snapshots', async () => {
  const c = client(); await tick()
  c.watchers.get('room_signals').onChange({ docs: [personal(1)] })
  assert.deepEqual(Array.from(c.queries.find(query => query.name === 'room_states').query.readers.$in), ['b'])
  c.watchers.get('room_states').onChange({ docs: [publicDoc(1, 1)] })
  assert.equal(c.received[0].game.myRole.role, '预言家')
  assert.equal(c.received[0].game.dayView.stage, 'SHERIFF_VOTE')
  assert.equal(c.received[0].game.dayView.submitted, true)
  c.watchers.get('room_states').onChange({ docs: [publicDoc(2, 2)] })
  assert.equal(c.received.length, 1)
  c.watchers.get('room_signals').onChange({ docs: [personal(2, '女巫')] })
  assert.equal(c.received[1].game.myRole.role, '女巫')
  c.watchers.get('room_states').onChange({ docs: [publicDoc(2, 2), publicDoc(1, 1)] })
  c.watchers.get('room_signals').onChange({ docs: [personal(1)] })
  assert.equal(c.received.length, 2)
  c.watchers.get('room_states').onChange({ docs: [publicDoc(3, 2)] })
  assert.equal(c.received.length, 3)
  assert.equal(c.refreshed(), 0)
  c.stop()
})

test('reconnect bootstraps once, closes both watchers and ignores callbacks after identity switch or stop', async () => {
  const c = client(); await tick()
  c.watchers.get('room_signals').onChange({ docs: [personal(1)] })
  c.watchers.get('room_states').onChange({ docs: [publicDoc(1, 1)] })
  c.watchers.get('room_states').onError()
  assert.equal(c.statuses.at(-1), false)
  assert.deepEqual(c.closed.sort(), ['room_signals', 'room_states'])
  c.retries[0](); await tick()
  assert.equal(c.bootstrap(), 2)
  c.watchers.get('room_signals').onChange({ docs: [personal(2)] })
  c.switchIdentity()
  c.watchers.get('room_states').onChange({ docs: [publicDoc(2, 2)] })
  assert.equal(c.received.length, 1)
  c.stop()
})

test('a departure clears local state immediately through the personal subscription', async () => {
  const c = client(); await tick()
  c.watchers.get('room_signals').onChange({ docs: [{ _id: 'b', protocol: 2, roomId: '', revision: 2, state: null }] })
  assert.equal(c.received[0], null)
  assert.equal(c.refreshed(), 0)
  c.stop()
})

test('connected direct subscriptions never run the periodic room query', () => {
  let now = 1000, interval, status, requests = 0
  const context = { exports: {}, Date: { now: () => now }, Math,
    setInterval: fn => { interval = fn; return 1 }, clearInterval() {},
    require: name => name.includes('virtual-users') ? { identityGeneration: () => 0 } : { watchRoom: (_refresh, connected) => { status = connected; return () => {} } } }
  const businessRequire = context.require
  context.require = name => name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/room-controller.js'), 'utf8'), context)
  const stop = context.exports.watchRoom(async () => { requests++ }, () => {}, () => null, () => {})
  status(true); now += 100000; interval()
  assert.equal(requests, 0)
  status(false); interval()
  assert.equal(requests, 1)
  stop()
})

test('broadcast renewal never postpones a stage sharing the old lease deadline; expiry is pushed', async () => {
  const s = server(fixture()), game = s.docs('games')[0]
  game.night.cue = 'OPEN'; game.stageReadyAt = s.now() + 10000
  await s.db.collection('games').doc('g').set({ data: game })
  await s.call('subscribeRoom')
  const payload = { sessionId: 'subscription_lease_001' }
  await s.call('heartbeatBroadcast', payload)
  assert.equal(s.docs('room_states')[0].state.broadcast.online, true)
  s.advance(3000)
  await s.call('heartbeatBroadcast', payload)
  assert.equal(s.docs('game_tasks')[0].dueAt, game.stageReadyAt)
  assert.equal(s.docs('game_tasks')[0].stageDueAt, game.stageReadyAt)
  s.advance(7001); await s.timer()
  assert.equal(s.docs('games')[0].night.cue, 'ACTION')
  const waiting = server(fixture(true))
  await waiting.call('subscribeRoom')
  await waiting.call('heartbeatBroadcast', payload)
  waiting.advance(10001); await waiting.timer()
  assert.equal(waiting.docs('room_states')[0].state.broadcast.online, false)
  assert.equal(waiting.docs('game_tasks').length, 0)
})

test('public projection omits unknown fields instead of accidentally publishing new secrets', () => {
  const { splitView } = require('../cloudfunctions/api/state-publisher')
  const split = splitView({ id: 'r', version: 1, secret: 'top-secret', game: { id: 'g', phase: 'NIGHT', newHiddenAction: 'secret', myRole: { role: '狼人' } } })
  assert.equal(JSON.stringify(split.publicView).includes('secret'), false)
  assert.equal(split.privateView.game.myRole.role, '狼人')
})

test('note pushes update saved rows without overwriting newer local drafts', () => {
  let page
  const context = { exports: {}, Page: value => { page = value; page.setData = patch => Object.assign(page.data, patch) },
    require: name => name.includes('domain/notes') ? require(path.join(build, 'miniprogram/domain/notes.js')) : {} }
  const businessRequire = context.require
  context.require = name => name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/notes/notes.js'), 'utf8'), context)
  const room = { members: [{ seat: 1, nickname: 'a' }, { seat: 2, nickname: 'b' }] }
  page.visible = true; page.gameId = 'g'; page.data.room = room
  page.data.rows = require(path.join(build, 'miniprogram/domain/notes.js')).noteRows(room, [{ targetSeat: 1, tags: [], tendency: '未知', text: 'local draft' }, { targetSeat: 2, tags: [], tendency: '未知', text: 'old' }])
  page.dirty = { '1': 1 }; page.cloudRevisions = { '1': 1, '2': 1 }
  page.applyNotes('g', [{ targetSeat: 1, revision: 2, tags: [], tendency: '未知', text: 'remote draft' }, { targetSeat: 2, revision: 2, tags: [], tendency: '未知', text: 'remote saved' }])
  assert.equal(page.data.rows.find(row => row.seat === 1).text, 'local draft')
  assert.equal(page.data.rows.find(row => row.seat === 2).text, 'remote saved')
  assert.equal(page.cloudRevisions['1'], 1)
  assert.equal(page.cloudRevisions['2'], 2)
})

test('seat selection shows pending until the committed subscription arrives, and ignores repeat taps', async () => {
  let page, calls = 0
  const context = { exports: {}, wx: { showToast() {} }, setTimeout: () => 1, clearTimeout() {},
    Page: value => { page = value; page.setData = patch => Object.assign(page.data, patch) },
    require: name => name.includes('api/client') ? { api: { selectSeat: async () => { calls++; return { accepted: true, version: 2 } } } } : name.includes('page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : {} }
  const businessRequire = context.require
  context.require = name => name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/room/room.js'), 'utf8'), context)
  const room = { id: 'r', status: 'WAITING', ownerId: 'a', version: 1, broadcast: { version: 0 }, config: { total: 4 }, members: [{ userId: 'a', nickname: 'a', seat: 1 }] }
  page.visible = true; page.data.myId = 'a'; page.applyRoom(room)
  await page.pickSeat({ currentTarget: { dataset: { seat: 4 } } })
  assert.equal(page.data.pendingSeat, 4)
  assert.equal(page.data.mySeat, 1)
  await page.pickSeat({ currentTarget: { dataset: { seat: 3 } } })
  assert.equal(calls, 1)
  page.applyRoom({ ...room, version: 2, members: [{ userId: 'a', nickname: 'a', seat: 4 }] })
  assert.equal(page.data.pendingSeat, 0)
  assert.equal(page.data.mySeat, 4)
  await page.pickSeat({ currentTarget: { dataset: { seat: 4 } } })
  assert.equal(calls, 1)
})

function telemetryClient() {
  let now = 1000
  const logs = []
  const context = { exports: {}, Date: { now: () => now }, console: { info: (label, value) => logs.push({ label, ...value }) } }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/telemetry.js'), 'utf8'), context)
  return { api: context.exports, logs, advance: ms => { now += ms } }
}
test('diagnostics correlate acknowledgement, subscription and render without logging game contents', () => {
  const c = telemetryClient()
  c.api.beginOperation('selectSeat', 'request_one', 990)
  c.advance(100); c.api.finishRequest('selectSeat', 'request_one', 1000, undefined, { roomId: 'r', version: 2 })
  c.advance(50); c.api.stateReceived('r', 2, 3)
  c.advance(20); c.api.renderFinished('r', 2, 1150, 4)
  assert.equal(c.logs.find(log => log.event === 'request_sent').localMs, 10)
  assert.equal(c.logs.find(log => log.event === 'request_finished').roundTripMs, 100)
  assert.equal(c.logs.find(log => log.event === 'operation_state_received').endToEndMs, 160)
  assert.equal(c.logs.find(log => log.event === 'operation_rendered').endToEndMs, 180)
  c.api.stateReceived('r', 3, 4); c.api.renderFinished('r', 3, 1170, 4)
  assert.equal(c.logs.filter(log => log.event === 'operation_rendered').length, 1)
  assert.ok(c.logs.every(log => !('payload' in log) && !('state' in log) && !('userId' in log)))
})
test('diagnostics preserve push and render timings when both precede the acknowledgement', () => {
  const c = telemetryClient()
  c.api.beginOperation('confirmDawn', 'request_two')
  c.advance(50); c.api.stateReceived('r', 2)
  c.advance(20); c.api.renderFinished('r', 2, 1050, 3)
  c.advance(100); c.api.finishRequest('confirmDawn', 'request_two', 1000, undefined, { roomId: 'r', version: 2 })
  assert.equal(c.logs.find(log => log.event === 'operation_state_received').endToEndMs, 50)
  assert.equal(c.logs.find(log => log.event === 'operation_rendered').endToEndMs, 70)
  assert.equal(c.logs.find(log => log.event === 'request_finished').roundTripMs, 170)
})
test('failed requests and diagnostic resets cannot later report successful end-to-end timings', () => {
  const c = telemetryClient()
  c.api.beginOperation('selectSeat', 'request_failed')
  c.api.finishRequest('selectSeat', 'request_failed', 1000, 'SEAT_TAKEN')
  c.api.beginOperation('selectSeat', 'request_reset')
  c.api.resetDiagnostics()
  c.api.finishRequest('selectSeat', 'request_reset', 1000, undefined, { roomId: 'r', version: 2 })
  c.api.stateReceived('r', 2); c.api.renderFinished('r', 2, 1000, 2)
  assert.equal(c.logs.filter(log => log.event === 'operation_rendered').length, 0)
  assert.equal(c.logs.find(log => log.requestId === 'request_failed' && log.event === 'request_finished').errorCode, 'SEAT_TAKEN')
})
test('render timing is recorded only after the actual setData callback', () => {
  const events = [], context = { exports: {}, Date, require: () => ({ renderFinished: (...args) => events.push(args) }) }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/page-data.js'), 'utf8'), context)
  let callback
  const page = { data: {}, setData: (_data, done) => { callback = done } }
  context.exports.setChangedData(page, { room: { id: 'r', version: 2 } })
  assert.equal(events.length, 0)
  callback()
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'r'); assert.equal(events[0][1], 2)
})
test('server request logs contain trace IDs and phase durations, and distinguish first invocation', async () => {
  const s = server(fixture(true)), logs = []
  s.context.console.info = (label, value) => logs.push({ label, ...value })
  const requestId = 'telemetry_request_00001'
  await s.main({ action: 'selectSeat', traceId: requestId, delivery: 'subscription', payload: { requestId, version: 1, seat: 4 } }, 'b')
  const log = logs.find(log => log.label === 'api metrics')
  assert.equal(log.requestId, requestId); assert.equal(log.firstInvocation, true)
  assert.equal(log.roomId, 'r'); assert.equal(log.version, 2)
  for (const key of ['identityMs', 'transactionMs', 'transactionCallbackMs', 'databaseReadMs', 'databaseWriteMs', 'snapshotPrepareMs', 'commandMs', 'transactionCommitAndRetryMs']) assert.ok(log[key] >= 0, key)
  assert.equal(log.transactionAttempts, 1)
  assert.equal('payload' in log, false)
  await s.main({ action: 'getRoom', traceId: 'trace_query_001' })
  assert.equal(logs.filter(log => log.label === 'api metrics')[1].firstInvocation, false)
})

test('successful personal snapshots cannot reset repeated public failures to one-second retries', async () => {
  const c = client(); await tick()
  const staleErrors = []
  for (let i = 0; i < 3; i++) {
    c.watchers.get('room_signals').onChange({ docs: [personal(1)] })
    const publicWatcher = c.watchers.get('room_states')
    staleErrors.push(publicWatcher)
    publicWatcher.onError({ code: 'DATABASE_PERMISSION_DENIED', message: 'permission denied for private OpenID secret-value' })
    assert.equal(c.diagnostics.filter(log => log.event === 'subscription_reconnect').at(-1).retryDelayMs, 1000 * 2 ** i)
    assert.equal(c.statuses.includes(true), false)
    staleErrors[0].onError({ code: 'STALE' })
    assert.equal(c.retries.length, i + 1)
    c.retries[i](); await tick()
  }
  const errors = c.diagnostics.filter(log => log.event === 'subscription_reconnect')
  assert.ok(errors.every(log => log.channel === 'public' && log.reason === 'permission_denied' && log.errorCode === 'DATABASE_PERMISSION_DENIED'))
  assert.equal(JSON.stringify(errors).includes('secret-value'), false)
  c.watchers.get('room_signals').onChange({ docs: [personal(1)] })
  c.watchers.get('room_states').onChange({ docs: [publicDoc(1, 1)] })
  c.watchers.get('room_states').onError({ code: 'NETWORK_TIMEOUT' })
  assert.equal(c.diagnostics.filter(log => log.event === 'subscription_reconnect').at(-1).retryDelayMs, 1000)
  c.stop()
})
test('synchronous public watch setup failures are diagnosed and retried without escaping callbacks', async () => {
  const c = client({ errCode: -502003, errMsg: 'permission denied' }); await tick()
  assert.doesNotThrow(() => c.watchers.get('room_signals').onChange({ docs: [personal(1)] }))
  const error = c.diagnostics.find(log => log.event === 'subscription_reconnect')
  assert.equal(error.channel, 'public'); assert.equal(error.errorCode, '-502003'); assert.equal(error.reason, 'permission_denied')
  assert.equal(c.retries.length, 1)
  c.stop()
})
test('errors from a public watcher closed during a room switch cannot disconnect the new room', async () => {
  const c = client(); await tick()
  c.watchers.get('room_signals').onChange({ docs: [personal(1)] })
  const old = c.watchers.get('room_states')
  c.watchers.get('room_signals').onChange({ docs: [{ ...personal(1), roomId: 'next-room' }] })
  old.onError({ code: 'CLOSED' })
  assert.equal(c.retries.length, 0)
  c.stop()
})

test('subscription diagnostics inspect wrapped SDK causes instead of hiding errMsg behind generic message', () => {
  const { subscriptionError } = require(path.join(build, 'miniprogram/services/telemetry.js'))
  const timeout = subscriptionError({ errCode: -402002, message: 'realtime listener init watch fail', errMsg: 'login fail Error: wsclient.send timedout' })
  assert.equal(timeout.errorCode, '-402002'); assert.equal(timeout.reason, 'network_or_timeout')
  const permission = subscriptionError({ errCode: -402002, message: 'realtime listener init watch fail', errMsg: { message: 'permission denied private-query-value' } })
  assert.equal(permission.reason, 'permission_denied')
  assert.equal(JSON.stringify(permission).includes('private-query-value'), false)
  const cycle = { message: 'socket timeout' }; cycle.cause = cycle
  assert.equal(subscriptionError(cycle).reason, 'network_or_timeout')
})

test('room, role and game pages issue only one state-driven navigation until it fails or they show again', () => {
  for (const name of ['room', 'role', 'game']) {
    let page
    const routes = []
    const context = { exports: {}, clearInterval() {},
      wx: { reLaunch: options => routes.push(options), redirectTo: options => routes.push(options) },
      Page: value => { page = value }, require: () => ({ showError() {} }) }
    vm.createContext(context)
    vm.runInContext(fs.readFileSync(path.join(build, `miniprogram/pages/${name}/${name}.js`), 'utf8'), context)
    page.visible = true
    // Query and subscription can both deliver the same routing state before onHide.
    page.applyRoom(null)
    page.applyRoom(null)
    page.navigateAway('/pages/index/index', true)
    assert.equal(routes.length, 1, name)
    routes[0].fail({ errMsg: 'route failed' })
    page.applyRoom(null)
    assert.equal(routes.length, 2, name)
    page.visible = false
    page.applyRoom(null)
    assert.equal(routes.length, 2, name)
  }
})

test('subscription errors persist bounded local details, including non-enumerable Error fields and nested causes', () => {
  let stored
  const context = { exports: {}, Date, console: { info() {} },
    wx: { getStorageSync: () => stored, setStorageSync: (_key, value) => { stored = value } } }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/telemetry.js'), 'utf8'), context)
  const error = new Error('listener failed')
  error.errCode = -402002
  error.cause = new Error('wsclient.send timedout')
  error.cause.cause = error
  error.query = { secret: 'not logged' }
  for (let i = 0; i < 35; i++) context.exports.recordSubscriptionError('personal', error, 1000)
  assert.equal(stored.length, 30)
  const latest = stored[29]
  assert.equal(latest.reason, 'network_or_timeout')
  assert.equal(latest.error.message, 'listener failed')
  assert.equal(latest.error.cause.message, 'wsclient.send timedout')
  assert.equal(latest.error.cause.cause, '[circular]')
  assert.equal(latest.error.query, undefined)
  context.wx.setStorageSync = () => { throw new Error('quota exceeded') }
  assert.doesNotThrow(() => context.exports.recordSubscriptionError('public', error, 2000))
})
