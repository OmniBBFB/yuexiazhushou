const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { database } = require('./helpers/database')
const apiRoot = path.resolve(__dirname, '../cloudfunctions/api')
function server(seed, clock = Date.now()) {
  const memory = database(seed)
  const context = { exports: {}, Date: class extends Date { static now() { return clock } }, console: { error() {}, info() {} },
    require: name => name === 'wx-server-sdk' ? { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => memory.db, getWXContext: () => ({ OPENID: 'unused' }) } : name.startsWith('./') ? require(path.join(apiRoot, name)) : require(name) }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(apiRoot, 'index.js'), 'utf8'), context)
  return { ...memory, context, call: (action, payload, user = 'a') => context.dispatch(action, payload, user), advance: ms => { clock += ms } }
}
function fixture(phase = 'ROLE_REVEAL') {
  const members = ['a', 'b', 'c'].map((id, i) => ({ userId: id, openid: id, authOpenid: id, nickname: id, seat: i + 1, ready: true, alive: true, roleConfirmed: false, isBot: false }))
  return {
    users: members.map(item => ({ _id: item.userId, openid: item.openid, authOpenid: item.openid, currentRoomId: 'r', nickname: item.nickname })),
    rooms: [{ _id: 'r', code: '123456', ownerId: 'a', version: 1, status: 'PLAYING', gameId: 'g', config: { total: 3, interval: 1 }, members }],
    games: [{ _id: 'g', roomId: 'r', day: 1, phase, nightStage: 'WEREWOLF', stageReadyAt: 0, confirmedUserIds: [], actions: {}, night: { cue: 'ACTION' }, dayState: {}, publicResult: [], roles: { a: { role: '狼人', alive: true, abilities: {} }, b: { role: '狼人', alive: true, abilities: {} }, c: { role: '村民', alive: true, abilities: {} } } }],
  }
}
test('witch cannot use both medicines in one night; rejection preserves state and each single medicine remains valid', async () => {
  for (const choice of [{ useSave: true, poisonSeat: 0 }, { useSave: false, poisonSeat: 3 }, { useSave: false, poisonSeat: 0 }]) {
    const seed = fixture('NIGHT')
    const game = seed.games[0]
    game.nightStage = 'WITCH'; game.night.attackedSeat = 2
    game.roles.a = { role: '女巫', alive: true, abilities: { antidote: true, poison: true } }
    const s = server(seed)
    await assert.rejects(s.call('submitNightAction', { version: 1, useSave: true, poisonSeat: 3, requestId: 'witch_conflict_000001' }), { code: 'WITCH_MEDICINE_CONFLICT' })
    assert.deepEqual(s.docs('games'), seed.games)
    assert.deepEqual(s.docs('rooms'), seed.rooms)
    assert.equal(s.docs('command_receipts').length, 0)
    await s.call('submitNightAction', { version: 1, ...choice })
    const saved = s.docs('games')[0]
    assert.equal(saved.roles.a.abilities.antidote, !choice.useSave)
    assert.equal(saved.roles.a.abilities.poison, !choice.poisonSeat)
    assert.equal(saved.actions['1:NIGHT:WITCH:a'].useSave, choice.useSave)
    assert.equal(saved.actions['1:NIGHT:WITCH:a'].poisonSeat, choice.poisonSeat)
  }
})
test('bot witch saves or poisons exclusively, and can poison when the antidote is unavailable', () => {
  for (const antidote of [true, false]) {
    const seed = fixture('NIGHT'), game = seed.games[0], room = seed.rooms[0]
    room.members[0].isBot = true
    game.nightStage = 'WITCH'; game.night.attackedSeat = 2
    game.roles.a = { role: '女巫', alive: true, abilities: { antidote, poison: true } }
    const s = server(seed)
    const helpers = vm.runInContext('({member, aliveRole, confirmationMembers, publiclyAlive, phaseKey})', s.context)
    const rules = require('../cloudfunctions/api/game-rules').createGameRules({ ...helpers, now: () => 0, crypto: { randomInt: n => n === 2 ? 1 : 0 }, fail: (code, message) => { throw Object.assign(new Error(message), { code }) } })
    rules.runBots(game, room)
    const action = game.actions['1:NIGHT:WITCH:a']
    assert.equal(action.useSave, antidote)
    assert.equal(!!action.poisonSeat, !antidote)
    assert.equal(game.roles.a.abilities.poison, antidote)
  }
})
test('game, room, notifications and receipt roll back together on any write failure', async () => {
  for (const collection of ['games', 'rooms', 'room_signals', 'command_receipts']) {
    const seed = fixture(), s = server(seed)
    s.failWrite(name => name === collection)
    await assert.rejects(s.call('confirmRole', { version: 1, requestId: 'request_atomic_0001' }), /injected write failure/)
    assert.deepEqual(s.docs('games'), seed.games)
    assert.deepEqual(s.docs('rooms'), seed.rooms)
    assert.equal(s.docs('room_signals').length, 0)
    assert.equal(s.docs('command_receipts').length, 0)
  }
})
test('simultaneous confirmations reject stale intent without losing the committed confirmation', async () => {
  const s = server(fixture())
  const results = await Promise.allSettled([s.call('confirmRole', { version: 1 }, 'a'), s.call('confirmRole', { version: 1 }, 'b')])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'STALE_STATE')
  const first = s.docs('games')[0].confirmedUserIds[0], other = first === 'a' ? 'b' : 'a'
  await s.call('confirmRole', { version: 2 }, other)
  assert.deepEqual(s.docs('games')[0].confirmedUserIds.sort(), ['a', 'b'])
  assert.equal(s.docs('rooms')[0].version, 3)
})
test('simultaneous wolf selections preserve the winning action and can retry from the latest version', async () => {
  const s = server(fixture('NIGHT'))
  const results = await Promise.allSettled([s.call('submitNightAction', { version: 1, targetSeat: 3 }, 'a'), s.call('submitNightAction', { version: 1, targetSeat: 3 }, 'b')])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  const actions = s.docs('games')[0].actions
  assert.equal(Object.keys(actions).length, 1)
  const next = Object.keys(actions)[0].endsWith(':a') ? 'b' : 'a'
  await s.call('submitNightAction', { version: 2, targetSeat: 3 }, next)
  assert.equal(Object.keys(s.docs('games')[0].actions).length, 2)
  assert.equal(s.docs('games')[0].night.cue, 'CLOSE')
})
test('request receipts replay lost responses, reject reused IDs and isolate users', async () => {
  const s = server(fixture()), payload = { version: 1, requestId: 'request_repeat_0001' }
  const first = await s.call('confirmRole', payload)
  const second = await s.call('confirmRole', payload)
  assert.equal(second.version, first.version)
  assert.equal(s.docs('rooms')[0].version, 2)
  assert.equal(s.docs('games')[0].confirmedUserIds.length, 1)
  await assert.rejects(s.call('confirmRole', { ...payload, version: 2 }), { code: 'REQUEST_MISMATCH' })
  await s.call('confirmRole', { ...payload, version: 2 }, 'b')
  assert.equal(s.docs('command_receipts').length, 2)
})
test('database read failures never repair rooms; proven missing games repair atomically', async () => {
  const seed = fixture(), s = server(seed)
  s.failRead(name => name === 'games')
  await assert.rejects(s.call('session', {}), /database unavailable/)
  assert.deepEqual(s.docs('rooms'), seed.rooms)
  s.failRead(null)
  await s.db.collection('games').doc('g').remove()
  s.failWrite(name => name === 'room_signals')
  await assert.rejects(s.call('session', {}), /injected write failure/)
  assert.deepEqual(s.docs('rooms'), seed.rooms)
  s.failWrite(null)
  const session = await s.call('session', {})
  assert.equal(session.room.status, 'WAITING')
  assert.equal(s.docs('rooms')[0].gameId, '')
  assert.ok(s.docs('rooms')[0].members.every(row => !row.ready && row.alive))
})
test('new identities use one stable record even during concurrent initialization', async () => {
  const s = server({})
  const users = await Promise.all([s.context.getUser('new-user'), s.context.getUser('new-user')])
  assert.equal(users[0]._id, users[1]._id)
  assert.equal(s.docs('users').length, 1)
})
test('joining the last place and the user pointer are atomic under concurrency and failures', async () => {
  const seed = fixture(); seed.rooms[0].status = 'WAITING'; seed.rooms[0].gameId = ''; seed.rooms[0].members = seed.rooms[0].members.slice(0, 1); seed.rooms[0].config.total = 2
  seed.users[1].currentRoomId = ''; seed.users[2].currentRoomId = ''; seed.rooms[0].passwordHash = ''
  const s = server(seed)
  const results = await Promise.allSettled([s.call('joinRoom', { code: '123456', password: '' }, 'b'), s.call('joinRoom', { code: '123456', password: '' }, 'c')])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'ROOM_FULL')
  const room = s.docs('rooms')[0]
  for (const user of s.docs('users')) assert.equal(user.currentRoomId === 'r', room.members.some(row => row.userId === user._id))
  const failing = server(seed); failing.failWrite(name => name === 'users')
  await assert.rejects(failing.call('joinRoom', { code: '123456', password: '' }, 'b'), /injected/)
  assert.deepEqual(failing.docs('rooms'), seed.rooms)
})
test('new game creation rolls back when publishing fails and cannot restart a running game', async () => {
  const seed = fixture(); seed.rooms[0].status = 'WAITING'; seed.rooms[0].gameId = ''; seed.rooms[0].config = { total: 6, wolves: 2, gods: 2, godRoles: ['预言家', '女巫'], villagers: 2, interval: 1, winMode: '屠边' }
  for (let i = 3; i < 6; i++) seed.rooms[0].members.push({ userId: `bot:${i}`, seat: i + 1, ready: true, alive: true, isBot: true })
  const s = server(seed); s.failWrite(name => name === 'room_signals')
  await assert.rejects(s.call('startGame', { version: 1 }), /injected/)
  assert.equal(s.docs('games').length, 1)
  assert.equal(s.docs('rooms')[0].gameId, '')
  s.failWrite(null)
  const room = await s.call('startGame', { version: 1 })
  assert.equal(room.status, 'PLAYING')
  assert.equal(s.docs('games').length, 2)
  await assert.rejects(s.call('startGame', { version: 2 }), { code: 'LOCKED' })
})
test('batch notes compare revisions, preserve atomicity and converge on one document per seat', async () => {
  const s = server(fixture())
  const note = { targetSeat: 1, text: 'first', tags: [], revision: 0 }
  const results = await Promise.allSettled([s.call('saveNote', { note, gameId: 'g' }), s.call('saveNote', { note: { ...note, text: 'second' }, gameId: 'g' })])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'NOTE_CONFLICT')
  assert.equal(s.docs('notes').length, 1)
  assert.equal(s.docs('notes')[0].revision, 1)
  await assert.rejects(s.call('saveNotes', { gameId: 'g', notes: [{ ...note, revision: 1 }, { targetSeat: 2, text: 'new', revision: 9 }] }), { code: 'NOTE_CONFLICT' })
  assert.equal(s.docs('notes').length, 1)
  const saved = await s.call('saveNotes', { gameId: 'g', notes: [{ ...note, revision: 1 }, { targetSeat: 2, text: 'new', revision: 0 }] })
  assert.deepEqual(Array.from(saved, row => row.revision), [2, 1])
  assert.equal(s.docs('notes').length, 2)
  const privateNotes = await s.call('listNotes', { gameId: 'g' }, 'b')
  assert.equal(privateNotes.length, 0)
})
test('idle snapshot reads do not open write transactions; concurrent due events advance once', async () => {
  const seed = fixture('NIGHT'); seed.games[0].night.cue = 'OPEN'; seed.games[0].stageReadyAt = Date.now() + 10000
  const s = server(seed)
  await s.call('getRoom', {})
  assert.equal(s.metrics.transactions, 0)
  s.advance(11000)
  await Promise.all([s.call('getRoom', {}, 'a'), s.call('getRoom', {}, 'b')])
  assert.equal(s.docs('games')[0].night.cue, 'ACTION')
  assert.equal(s.docs('rooms')[0].version, 2)
})

test('departed night role keeps cues, waits 5–20 seconds once, and advances without an action', async () => {
  const seed = fixture('NIGHT'), clock = Date.now()
  seed.games[0].night.cue = 'CLOSE'
  seed.games[0].roles.c = { role: '预言家', alive: false, abilities: {} }
  seed.rooms[0].members[2].alive = false
  const s = server(seed, clock)
  let room = await s.call('getRoom', {})
  assert.equal(room.game.nightStage, 'SEER')
  assert.equal(room.game.nightCue, 'OPEN')
  s.advance(room.game.stageReadyAt - clock + 1)
  room = await s.call('getRoom', {})
  assert.equal(room.game.nightCue, 'ACTION')
  const duration = room.game.stageReadyAt - room.game.serverTime
  assert.ok(duration >= 5000 && duration <= 20000)
  assert.equal(duration % 1000, 0)
  assert.equal(room.game.myAction, undefined)
  assert.equal((await s.call('getRoom', {}, 'c')).game.myAction, undefined)
  assert.equal((await s.call('getRoom', {})).game.stageReadyAt, room.game.stageReadyAt)
  s.advance(duration - 1)
  assert.equal((await s.call('getRoom', {})).game.nightCue, 'ACTION')
  s.advance(2)
  room = await s.call('getRoom', {})
  assert.equal(room.game.nightCue, 'CLOSE')
  assert.equal(Object.keys(s.docs('games')[0].actions).length, 0)
  s.advance(room.game.stageReadyAt - room.game.serverTime + 1)
  room = await s.call('getRoom', {})
  assert.equal(room.game.phase, 'DAWN')
  assert.equal(s.docs('games')[0].nightStage, '')
})

test('vote history publishes resolved rounds, survives night/day transitions, and hides unfinished votes', async () => {
  const seed = fixture('DAY'), game = seed.games[0]
  game.firstNightRevealed = true
  game.dayState = { stage: 'EXILE_VOTE', sheriffSeat: 1, exileVotes: {}, exileRound: 1, candidates: [] }
  const s = server(seed)
  await s.call('exileVote', { version: 1, targetSeat: 3 }, 'a')
  const incomplete = await s.call('getRoom', {}, 'b')
  assert.equal(incomplete.game.voteHistory.length, 0)
  assert.equal(JSON.stringify(incomplete).includes('exileVotes'), false)
  await s.call('exileVote', { version: 2, targetSeat: 3 }, 'b')
  await s.call('exileVote', { version: 3, targetSeat: 0 }, 'c')
  const completed = await s.call('getRoom', {}, 'b')
  assert.equal(completed.game.voteHistory.length, 1)
  const report = completed.game.voteHistory[0]
  assert.equal(report.day, 1)
  assert.equal(report.kind, 'EXILE')
  assert.equal(report.totals[0].votes, 2.5)
  assert.deepEqual(Array.from(report.totals[0].voterSeats), [1, 2])
  assert.deepEqual(Array.from(report.abstainedSeats), [3])
  const rules = vm.runInContext('rules', s.context), working = s.docs('games')[0], room = s.docs('rooms')[0]
  rules.startDay({ ...working, day: 2 }, room)
  assert.equal(working.voteHistory.length, 1)
  const projected = vm.runInContext('project', s.context)(room, { ...working, phase: 'NIGHT', day: 2, night: { cue: 'OPEN' } }, 'a')
  assert.equal(projected.game.voteHistory[0].day, 1)
  assert.equal(projected.game.myRole.role, '狼人')
  assert.equal(projected.game.roles, undefined)
})

test('maintenance reports duplicates and migrates legacy notes without deleting source data', async () => {
  const { inspect, migrate } = require('../cloudfunctions/api/maintenance')
  const seed = fixture(); seed.notes = [
    { _id: 'old1', gameId: 'g', ownerId: 'a', targetSeat: 1, text: 'older', updatedAt: new Date(1000) },
    { _id: 'old2', gameId: 'g', ownerId: 'a', targetSeat: 1, text: 'newer', updatedAt: new Date(2000) },
  ]
  const s = server(seed), report = await inspect(s.db)
  assert.equal(report.duplicateNotes.length, 1)
  assert.equal(JSON.stringify(report).includes('older'), false)
  await migrate(s.db)
  assert.equal(s.docs('room_codes')[0].roomId, 'r')
  assert.equal(s.docs('notes').length, 3)
  assert.equal((await s.call('listNotes', { gameId: 'g' }))[0].text, 'newer')
  await migrate(s.db)
  assert.equal(s.docs('notes').length, 3)
})

test('SDK error responses cannot masquerade as missing records or successful writes', async () => {
  const { transactionStore } = require('../cloudfunctions/api/repository')
  const db = { command: {}, serverDate: () => new Date() }
  const read = transactionStore({ collection: () => ({ doc: () => ({ get: async () => ({ code: 'DATABASE_UNAVAILABLE', message: 'unavailable' }) }) }) }, db)
  await assert.rejects(read.collection('games').doc('g').get(), { code: 'DATABASE_UNAVAILABLE' })
  const write = transactionStore({ collection: () => ({ doc: () => ({ set: async () => ({ code: 'DATABASE_UNAVAILABLE', message: 'unavailable' }) }) }) }, db)
  await write.collection('games').doc('g').set({ data: {} })
  await assert.rejects(write.flush(), { code: 'DATABASE_UNAVAILABLE' })
})

test('transactional missing-document errors are normalized narrowly and cached', async () => {
  const { transactionStore } = require('../cloudfunctions/api/repository')
  const db = { command: {}, serverDate: () => new Date() }
  let calls = 0
  const store = transactionStore({ collection: () => ({ doc: id => ({ get: async () => {
    calls++
    throw new Error(`document.get:fail document with _id ${id} does not exist`)
  } }) }) }, db)
  assert.equal((await store.collection('command_receipts').doc('new').get()).data, null)
  assert.equal((await store.collection('command_receipts').doc('new').get()).data, null)
  assert.equal(calls, 1)
  for (const message of ['collection does not exist', 'permission denied', 'network timeout', 'document.get:fail document with _id other does not exist']) {
    const failing = transactionStore({ collection: () => ({ doc: () => ({ get: async () => { throw new Error(message) } }) }) }, db)
    await assert.rejects(failing.collection('command_receipts').doc('new').get(), { message })
  }
})

test('durable cleanup keeps failures retryable, protects active games, and expires old receipts', async () => {
  const { cleanup } = require('../cloudfunctions/api/maintenance')
  const seed = fixture()
  seed.games.push({ _id: 'old-game' })
  seed.notes = [{ _id: 'old-note', gameId: 'old-game' }]
  seed.cleanup_tasks = [{ _id: 'old-game', gameId: 'old-game' }, { _id: 'g', gameId: 'g' }]
  seed.command_receipts = [{ _id: 'expired', expiresAt: new Date(1000) }, { _id: 'fresh', expiresAt: new Date(Date.now() + 60000) }]
  const s = server(seed)
  s.failWrite(name => name === 'notes')
  await cleanup(s.db)
  assert.equal(s.docs('cleanup_tasks').length, 2)
  assert.equal(s.docs('games').length, 2)
  assert.equal(s.docs('command_receipts').length, 1)
  s.failWrite(null)
  await cleanup(s.db)
  assert.equal(s.docs('cleanup_tasks').length, 1)
  assert.equal(s.docs('cleanup_tasks')[0].gameId, 'g')
  assert.equal(s.docs('games').length, 1)
  assert.equal(s.docs('notes').length, 0)
})
