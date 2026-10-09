const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const { cloudBackend } = require('./helpers/client-backend')

const root = path.resolve(__dirname, '..')
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-broadcast-tests-'))
execFileSync('tsc', ['--outDir', build, '--rootDir', root], { cwd: root })
const clone = value => JSON.parse(JSON.stringify(value))

test('global test switch saves notes before changing identity and routes from database facts', async () => {
  const events = []; let selected = 'host', route = '', failSession = false
  let session = { room: { status: 'PLAYING', game: { phase: 'ROLE_REVEAL' } } }
  const page = { writeDraft: () => events.push('draft:host'), onHide: () => events.push('hide:host'), saveAll: async () => { events.push(`save:${selected}`) }, onShow: () => events.push(`resume:${selected}`) }
  const context = { exports: {}, Promise, getCurrentPages: () => [page], wx: { showLoading() {}, hideLoading() {}, reLaunch: options => { route = options.url; options.success() } },
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('api/client') ? { api: { session: async () => { if (failSession) throw new Error('offline'); return session } } }
      : name.includes('broadcast') ? { stopBroadcast: () => events.push(`stop:${selected}`) }
      : { virtualSlots: ['host', 'player-1', 'player-2'], supportsVirtualUsers: () => true, virtualUser: () => selected, selectVirtualUser: slot => { selected = slot; events.push(`select:${slot}`) } },
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/test-switch.js'), 'utf8'), context)
  const change = context.exports.switchTestIdentity
  await change('player-1')
  assert.equal(route, '/pages/role/role')
  assert.ok(events.indexOf('save:host') < events.indexOf('select:player-1'))
  session = { room: { status: 'PLAYING', game: { phase: 'NIGHT' } } }
  await change('player-2'); assert.equal(route, '/pages/game/game')
  session = { room: { status: 'WAITING' } }
  await change('host'); assert.equal(route, '/pages/room/room')
  session = { room: null }
  await change('player-1'); assert.equal(route, '/pages/index/index')
  failSession = true
  await assert.rejects(change('host'), /offline/)
  assert.equal(selected, 'player-1')
  assert.equal(events[events.length - 1], 'resume:player-1')
})

test('virtual identities require server opt-in and allowlist, and remain stable and separated', () => {
  const { resolveIdentity, assertScope } = require('../cloudfunctions/api/virtual-users')
  const env = { VIRTUAL_TEST_ENABLED: 'true', VIRTUAL_TEST_OPENIDS: 'real-a, real-b' }
  assert.deepEqual(resolveIdentity('real-a', undefined, {}), { openid: 'real-a', testScope: '' })
  assert.throws(() => resolveIdentity('real-a', 'host', {}), { code: 'TEST_FORBIDDEN' })
  assert.throws(() => resolveIdentity('other', 'host', env), { code: 'TEST_FORBIDDEN' })
  assert.throws(() => resolveIdentity('real-a', 'arbitrary-user-id', env), { code: 'BAD_TEST_USER' })
  assert.throws(() => resolveIdentity(undefined, 'host', env), { code: 'UNAUTHENTICATED' })
  const host = resolveIdentity('real-a', 'host', env)
  const guest = resolveIdentity('real-a', 'player-1', env)
  assert.deepEqual(host, resolveIdentity('real-a', 'host', env))
  assert.notEqual(host.openid, guest.openid)
  assert.equal(host.testScope, guest.testScope)
  assert.notEqual(host.testScope, resolveIdentity('real-b', 'host', env).testScope)
  assert.doesNotThrow(() => assertScope({ testScope: host.testScope }, guest))
  assert.throws(() => assertScope({ testScope: host.testScope }, { testScope: '' }), { code: 'TEST_ROOM_ISOLATED' })
  assert.throws(() => assertScope({}, host), { code: 'TEST_ROOM_ISOLATED' })
  assert.throws(() => assertScope({ testScope: host.testScope }, resolveIdentity('real-b', 'host', env)), { code: 'TEST_ROOM_ISOLATED' })
})

test('virtual selection is simulator-only, in-memory and rejects arbitrary users', () => {
  function simulator(platform) {
    const context = { exports: {}, wx: { getDeviceInfo: () => ({ platform }) } }
    const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
    vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/virtual-users.js'), 'utf8'), context)
    return context.exports
  }
  const first = simulator('devtools'), second = simulator('devtools'), phone = simulator('ios')
  first.selectVirtualUser('host'); second.selectVirtualUser('player-1'); phone.selectVirtualUser('host')
  assert.equal(first.virtualUser(), 'host')
  assert.equal(second.virtualUser(), 'player-1')
  assert.equal(phone.virtualUser(), '')
  first.selectVirtualUser('actual-user-id')
  assert.equal(first.virtualUser(), 'host')
  first.selectVirtualUser('')
  assert.equal(first.virtualUser(), '')
  assert.equal(second.virtualUser(), 'player-1')
})

test('client captures virtual identity per request and rejects responses after switching', async () => {
  let generation = 0, selected = 'host', finish
  const sent = []
  const context = { exports: {}, Error, wx: { cloud: { callFunction: options => { sent.push(clone(options)); return new Promise(resolve => { finish = resolve }) } } },
    require: () => ({ virtualUser: () => selected, identityGeneration: () => generation }),
  }
  const businessRequire = context.require
  context.require = name => name.endsWith('/backend') ? cloudBackend(build, context.wx) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/api/client.js'), 'utf8'), context)
  const old = context.exports.api.session()
  selected = 'player-1'; generation++
  finish({ result: { ok: true, data: { profile: { id: 'host' } } } })
  await assert.rejects(old, /测试用户已切换/)
  assert.equal(sent[0].data.testUser, 'host')
  const next = context.exports.api.session()
  finish({ result: { ok: true, identity: { testUser: 'player-1', protocol: 1 }, data: { profile: { id: 'guest' } } } })
  assert.equal((await next).profile.id, 'guest')
  assert.equal(sent[1].data.testUser, 'player-1')
  selected = ''; generation++
  const real = context.exports.api.session()
  assert.equal(sent[2].data.testUser, undefined)
  finish({ result: { ok: true, data: {} } }); await real
  selected = 'host'; generation++
  const legacy = context.exports.api.session()
  finish({ result: { ok: true, data: { profile: { id: 'real' } } } })
  await assert.rejects(legacy, /云函数未确认虚拟身份/)
  const mismatch = context.exports.api.session()
  finish({ result: { ok: true, identity: { testUser: 'player-1', protocol: 1 }, data: {} } })
  await assert.rejects(mismatch, /云函数未确认虚拟身份/)
  const unsupported = context.exports.api.suggestWolfTarget(2, 1)
  finish({ result: { ok: false, error: { code: 'UNKNOWN_ACTION', message: '未知操作' } } })
  await assert.rejects(unsupported, /上传并部署最新云函数/)
})

test('virtual users share realtime sync while identity changes invalidate old listeners', async () => {
  let generation = 0, callbacks, query, refreshed = 0
  const context = { exports: {},
    require: name => name.includes('virtual-users') ? { identityGeneration: () => generation } : { api: { syncIdentity: async () => ({ userId: 'virtual-player', openid: 'real-owner' }) } },
    wx: { cloud: { database: () => ({ collection: () => ({ where: value => { query = value; return { watch: value => { callbacks = value; return { close: async () => {} } } } } }) }) } },
  }
  const businessRequire = context.require
  context.require = name => name.endsWith('/backend') ? cloudBackend(build, context.wx) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/room-sync.js'), 'utf8'), context)
  const stop = context.exports.watchRoom(() => refreshed++, () => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(query._openid, 'real-owner')
  assert.equal(query._id, 'virtual-player')
  callbacks.onChange({ docs: [{ _id: 'another-player', roomId: 'room', version: 1 }] })
  assert.equal(refreshed, 0)
  callbacks.onChange({ docs: [{ _id: 'virtual-player', roomId: 'room', version: 1 }] })
  assert.equal(refreshed, 1)
  generation++
  callbacks.onChange({ docs: [{ _id: 'virtual-player', roomId: 'room', version: 2 }] })
  assert.equal(refreshed, 1)
  stop()
})

test('virtual notification ownership uses verified real account, including legacy records', () => {
  const { resolveIdentity, notificationOpenid } = require('../cloudfunctions/api/virtual-users')
  const identity = resolveIdentity('real-owner', 'host', { VIRTUAL_TEST_ENABLED: 'true', VIRTUAL_TEST_OPENIDS: 'real-owner' })
  assert.equal(notificationOpenid({ ...identity, authOpenid: 'real-owner' }), 'real-owner')
  assert.equal(notificationOpenid(identity, 'real-owner'), 'real-owner')
  assert.throws(() => notificationOpenid(identity, 'other-owner'), { code: 'IDENTITY_MISMATCH' })
  assert.equal(notificationOpenid({ openid: 'real-owner' }), 'real-owner')
})

test('virtual notification documents are separate per player but authorized by the same real account', async () => {
  const s = server(), documents = new Map()
  const transaction = { collection: name => {
    assert.equal(name, 'room_signals')
    return { doc: id => ({ set: async ({ data }) => documents.set(id, data) }) }
  } }
  const members = ['host', 'player-1'].map(userId => ({ userId, openid: `virtual:scope:${userId}`, authOpenid: 'real-owner' }))
  await s.context.publishSignals(transaction, { _id: 'room', members, version: 3, broadcastVersion: 1 }, members)
  assert.equal(documents.size, 2)
  for (const data of documents.values()) {
    assert.equal(data._openid, 'real-owner')
    assert.deepEqual(Object.keys(data).sort(), ['_openid', 'broadcastVersion', 'roomId', 'version'])
  }
})

test('notes validate seats, isolate summary fields and preserve legacy guesses', () => {
  const { normalizeNote, noteView } = require('../cloudfunctions/api/note-format')
  const members = [{ seat: 1 }]
  assert.throws(() => normalizeNote({ targetSeat: 2 }, members), { code: 'BAD_TARGET' })
  assert.throws(() => normalizeNote({ targetSeat: 0 }, members), { code: 'BAD_TARGET' })
  const player = normalizeNote({ targetSeat: 1, roleGuess: '狼人', tags: ['上警', '上警'], text: 'a'.repeat(400), ownerId: 'other', gameId: 'other' }, members)
  assert.equal(player.text.length, 300)
  assert.deepEqual(player.tags, ['上警'])
  assert.equal(player.ownerId, undefined)
  assert.equal(player.gameId, undefined)
  assert.equal(noteView({ targetSeat: 1, tendency: '偏狼' }).roleGuess, '偏狼')
  const summary = normalizeNote({ kind: 'summary', targetSeat: 0, freeText: 'a'.repeat(1100), voteText: '1 → 2' }, members)
  assert.equal(summary.freeText.length, 1000)
  assert.equal(summary.voteText, '1 → 2')
})

test('speech notes support multiline input and preserve newlines through storage and rendering', () => {
  const text = '第一句\n第二句\n第三句'
  const { normalizeNote, noteView } = require('../cloudfunctions/api/note-format')
  const { noteRows, rowNote } = require(path.join(build, 'miniprogram/domain/notes.js'))
  const saved = noteView(normalizeNote({ targetSeat: 1, text }, [{ seat: 1 }]))
  assert.equal(saved.text, text)
  const rows = noteRows({ members: [{ seat: 1, nickname: '甲' }] }, [saved])
  assert.equal(rows[0].text, text)
  assert.equal(rowNote(rows[0]).text, text)
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/notes/notes.wxml'), 'utf8')
  assert.match(template, /<textarea class="speech-entry"[^>]*auto-height="\{\{true\}\}"/)
  assert.doesNotMatch(template, /<input class="speech-entry"/)
})

test('notebook rows use private guesses, never public revealed identities', () => {
  const { noteRows } = require(path.join(build, 'miniprogram/domain/notes.js'))
  const rows = noteRows({ members: [{ seat: 2, nickname: '乙', role: '狼人' }, { seat: 1, nickname: '甲', role: '女巫' }] }, [{ targetSeat: 2, tendency: '偏好', tags: ['上警'], text: '记录' }])
  assert.deepEqual(rows.map(row => row.seat), [1, 2])
  assert.equal(rows[0].roleGuess, '未知')
  assert.equal(rows[1].roleGuess, '偏好')
  assert.equal(rows[1].sheriff, '上警')
})

test('saving an older notebook edit cannot clear a newer pending edit; offline drafts remain', async () => {
  let page, finish, offline = false
  const storage = {}, sent = []
  const context = { exports: {}, Promise, Date, clearTimeout() {},
    wx: { setStorageSync: (key, value) => { storage[key] = clone(value) }, removeStorageSync: key => { delete storage[key] } },
    Page: value => { page = value; page.setData = data => Object.assign(page.data, data) },
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('api/client') ? { ApiError: Error, api: { saveNotes: notes => { sent.push(clone(notes[0])); return offline ? Promise.reject(new Error('offline')) : new Promise(resolve => { finish = () => resolve(notes.map(note => ({ ...note, revision: (note.revision || 0) + 1 }))) }) } } } : name.includes('domain/notes') ? require(path.join(build, 'miniprogram/domain/notes.js')) : {},
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/notes/notes.js'), 'utf8'), context)
  page.visible = true; page.gameId = 'g'; page.draftKey = 'private:g'
  page.data.rows = [{ seat: 1, roleGuess: '未知', tendency: '未知', tags: [], text: '旧记录' }]
  page.dirty = { 1: 1 }
  const first = page.saveAll(); await Promise.resolve()
  page.data.rows[0].text = '新记录'; page.dirty[1] = 2
  finish(); await first
  assert.equal(page.dirty[1], 2)
  assert.equal(storage['private:g'].notes[0].text, '新记录')
  offline = true; await page.saveAll()
  assert.equal(page.dirty[1], 2)
  assert.equal(storage['private:g'].notes[0].text, '新记录')
  offline = false
  const retry = page.saveAll(); await Promise.resolve(); finish(); await retry
  assert.equal(Object.keys(page.dirty).length, 0)
  assert.equal(storage['private:g'], undefined)
  assert.equal(sent[2].text, '新记录')
})

function server() {
  let now = 1000
  let room = { _id: 'room', ownerId: 'owner', version: 7, status: 'PLAYING', gameId: 'game', members: [
    { userId: 'owner', nickname: '房主', isBot: false },
    { userId: 'guest', nickname: '玩家', isBot: false },
    { userId: 'bot', nickname: '机器人', isBot: true },
  ] }
  const updates = [], signals = {}
  const ref = { get: async () => ({ data: clone(room) }), update: async ({ data }) => { updates.push(clone(data)); Object.assign(room, data) } }
  const db = { command: {}, serverDate: () => 'server-time', runTransaction: fn => fn({ collection: name => ({ doc: id => {
    if (name === 'rooms') { assert.equal(id, 'room'); return ref }
    if (name === 'users') return { get: async () => ({ data: { openid: `openid:${id}` } }) }
    if (name === 'cleanup_tasks') return { set: async () => {} }
    assert.equal(name, 'room_signals')
    return { set: async ({ data }) => { signals[id] = clone(data) } }
  } }) }) }
  const context = { Date: { now: () => now }, exports: {}, require: name => name === 'wx-server-sdk' ? { init() {}, database: () => db } : name === './auth' ? require('../cloudfunctions/api/auth') : name === './broadcast' ? require('../cloudfunctions/api/broadcast') : name === './room-command' ? require('../cloudfunctions/api/room-command') : name === './game-command' ? require('../cloudfunctions/api/game-command') : name === './game-rules' ? require('../cloudfunctions/api/game-rules') : name === './projection' ? require('../cloudfunctions/api/projection') : name === './repository' ? require('../cloudfunctions/api/repository') : name === './notes' ? require('../cloudfunctions/api/notes') : name === './room-config' ? require('../cloudfunctions/api/room-config') : name === './note-format' ? require('../cloudfunctions/api/note-format') : name === './virtual-users' ? require('../cloudfunctions/api/virtual-users') : require(name) }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/api/index.js'), 'utf8'), context)
  Object.assign(context, vm.runInContext('rules', context))
  context.project = vm.runInContext('project', context)
  // Aggregate rule tests use notification-only storage doubles. Full snapshot
  // publication, permissions, deduplication and rollback are tested separately.
  context.publishSignals = async (store, room, recipients) => {
    for (const item of recipients) await store.collection('room_signals').doc(item.userId).set({ data: {
      _openid: item.authOpenid || item.openid, roomId: room.members.some(member => member.userId === item.userId) ? room._id : '',
      version: room.version, broadcastVersion: room.broadcastVersion || 0,
    } })
  }
  const legacyBroadcast = require('../cloudfunctions/api/broadcast').createBroadcast({ db, now: () => now,
    fail: vm.runInContext('fail', context), member: context.member, assertMember: context.assertMember,
    signalRecipients: context.signalRecipients, publishSignals: context.publishSignals })
  context.updateBroadcast = (...args) => legacyBroadcast.updateBroadcast(...args)
  // These legacy tests isolate rules with mocked aggregate loaders. Atomic
  // dispatch/rollback is covered by repair.test.js with a transactional store.
  const dispatch = context.dispatch
  context.dispatch = async (action, payload, openid, scope = '', auth = openid) => {
    if (action === 'session' || action === 'getRoom') return dispatch(action, payload, openid, scope, auth)
    return context.mutate(action, payload, await context.getUser(openid, scope, auth), db, {})
  }
  return { context, updates, signals, room: () => room, advance: ms => { now += ms }, call: (user, action, payload) => context.updateBroadcast('room', user, action, payload) }
}

test('sheriff UI keeps actions and state without repeating election rules', () => {
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/game/game.wxml'), 'utf8')
  assert.doesNotMatch(template, /仅警下玩家可投票；上警玩家即使退水也不能投票|按座位号依次发言。退水后不再参选|每局共 2 次，可在同一回合连续使用/)
  for (const action of ['sheriffSignup', 'sheriffVote', 'withdrawSheriff', 'finishSpeech', 'extendSpeech']) assert.ok(template.includes(`bindtap="${action}"`))
  assert.ok(template.includes('无法投票'))
  assert.ok(template.includes('disabled="{{!selectedDaySeat}}" bindtap="sheriffVote"'))
})

test('ineligible voters get only a no-vote message before the interactive vote branches', () => {
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/game/game.wxml'), 'utf8')
  const blocked = template.split('\n').find(line => line.includes('无法投票'))
  assert.ok(blocked.includes("stage === 'SHERIFF_VOTE' && !room.game.dayView.canSheriffVote"))
  assert.ok(blocked.includes("stage === 'EXILE_VOTE' && !room.game.dayView.canExileVote"))
  assert.doesNotMatch(blocked, /<button|class="targets"|bindtap=/)
  assert.ok(template.indexOf(blocked) < template.indexOf('bindtap="sheriffVote"'))
  assert.ok(template.indexOf(blocked) < template.indexOf('bindtap="exileVote"'))
})

test('broadcast controls live on a dedicated page, with compact owner or broadcaster entry points', () => {
  for (const page of ['game', 'room']) {
    const template = fs.readFileSync(path.join(root, `miniprogram/pages/${page}/${page}.wxml`), 'utf8')
    assert.match(template, /wx:if="\{\{isOwner \|\| room.broadcast.userId === myId\}\}"[^>]*bindtap="openBroadcast"/)
    assert.doesNotMatch(template, /bindtap="transferBroadcast"|bindtap="replay"|你负责公共播报/)
  }
  const settings = fs.readFileSync(path.join(root, 'miniprogram/pages/broadcast/broadcast.wxml'), 'utf8')
  assert.match(settings, /wx:if="\{\{isOwner\}\}"[^>]*bindtap="transferBroadcast"/)
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8')).pages.includes('pages/broadcast/broadcast'))
})

test('broadcast settings keeps cue identity, enforces transfer permissions and stops on background', async () => {
  let page, changed = 0, stopped = 0, synced, pending
  const room = { id: 'room', ownerId: 'owner', version: 1, broadcast: { userId: 'guest', version: 0 }, game: { id: 'game', day: 1, phase: 'NIGHT', nightStage: 'WEREWOLF', nightCue: 'ACTION' } }
  const context = { exports: {}, clearInterval() {}, clearTimeout() {},
    wx: { navigateBack: () => {}, navigateTo: () => {} },
    Page: value => { page = value; page.setData = data => Object.assign(page.data, data) },
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('api/client') ? { api: { getRoom: () => new Promise(resolve => { pending = value => resolve(value.room) }), session: () => new Promise(resolve => { pending = resolve }) }, showError: error => { throw error } }
      : name.includes('/announcements') ? { announcementFor: () => ({ name: 'werewolf', text: '狼人请行动' }) }
      : name.includes('/broadcast') ? { syncBroadcast: async (...args) => { synced = args; return true }, stopBroadcast: () => { stopped++ }, chooseBroadcaster: async () => { changed++ } } : {},
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/broadcast/broadcast.js'), 'utf8'), context)
  page.visible = true; Object.assign(page.data, { room, myId: 'guest', isOwner: false })
  await page.announce()
  assert.equal(synced[3], 'game:1:NIGHT:WEREWOLF:ACTION')
  assert.equal(page.data.playingHere, true)
  await page.transferBroadcast()
  assert.equal(changed, 0)
  const request = page.load(false)
  page.onHide()
  pending({ room: { ...room, version: 2 }, profile: { id: 'guest' } }); await request
  assert.equal(page.data.room.version, 1)
  assert.equal(stopped, 1)
  page.visible = true; page.back(); page.onHide()
  assert.equal(stopped, 1)
})

test('paired action buttons constrain grid tracks and include padding in their width', () => {
  const style = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8')
  assert.match(style, /\.dual-actions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(style, /\.dual-actions button \{[^}]*min-width: 0;[^}]*box-sizing: border-box/)
})

test('witch UI separates attack, medicine and targets; poison selection is explicit', async () => {
  let page, submitted, toast
  const context = { exports: {}, Page: value => { page = value },
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('/api/client') ? { api: { submitNightAction: async value => { submitted = value; return {} } }, showError: error => { throw error } } : {},
    wx: { showToast: value => { toast = value.title } },
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/game/game.js'), 'utf8'), context)
  page.setData = value => Object.assign(page.data, value)
  page.applyRoom = () => {}
  Object.assign(page.data, { room: { version: 1 }, action: { type: 'WITCH', canSave: true, canPoison: true, attackedSeat: 2 }, actionReady: true })
  page.togglePoison({ detail: { value: true } })
  await page.submitAction()
  assert.equal(toast, '请选择毒药目标')
  assert.equal(submitted, undefined)
  page.selectPoison({ currentTarget: { dataset: { seat: 3 } } })
  assert.equal(page.data.poisonSeat, 3)
  page.toggleSave({ detail: { value: true } })
  assert.equal(page.data.useSave, true)
  assert.equal(page.data.usePoison, false)
  assert.equal(page.data.poisonSeat, 0)
  page.togglePoison({ detail: { value: true } })
  assert.equal(page.data.useSave, false)
  page.togglePoison({ detail: { value: false } })
  assert.equal(page.data.poisonSeat, 0)
  await page.submitAction()
  assert.equal(submitted.poisonSeat, 0)
  assert.equal(submitted.useSave, false)
  submitted = undefined
  Object.assign(page.data, { useSave: true, usePoison: true, poisonSeat: 3 })
  await page.submitAction()
  assert.equal(toast, '同一晚只能使用一种药剂')
  assert.equal(submitted, undefined)
  Object.assign(page.data, { useSave: false, usePoison: false, poisonSeat: 0 })
  page.data.action.attackedSeat = 0
  page.toggleSave({ detail: { value: true } })
  assert.equal(page.data.useSave, false)
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/game/game.wxml'), 'utf8')
  for (const title of ['1 · 今晚遇袭情况', '2 · 选择药剂', '3 · 选择目标', '遇袭不等于已经死亡']) assert.ok(template.includes(title))
})

test('wolf suggestions are private, do not count as votes, and split choices can be revised', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const roles = ['狼人', '狼人', '预言家', '村民', '狼人']
  const room = { _id: 'room', version: 1, ownerId: 'p2', status: 'PLAYING', config: { total: 5, interval: 1 }, members: roles.map((_, i) => ({ userId: `p${i}`, seat: i + 1, nickname: `玩家${i}`, alive: i !== 4 })) }
  const game = { _id: 'game', day: 1, phase: 'NIGHT', nightStage: 'WEREWOLF', stageReadyAt: 0, night: { cue: 'ACTION' }, confirmedUserIds: [], publicResult: [], actions: {}, roles: Object.fromEntries(roles.map((role, i) => [`p${i}`, { role, alive: i !== 4, abilities: {} }])) }
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game
  let saved = 0
  s.context.saveRoom = async () => { saved++; return room }
  db.collection = () => ({ doc: () => ({ update: async () => {} }) })
  await s.context.dispatch('suggestWolfTarget', { version: 1, targetSeat: 2 }, 'p0')
  assert.equal(game.night.wolfSuggestions.p0, 2)
  assert.equal(Object.keys(game.actions).length, 0)
  assert.equal(game.night.cue, 'ACTION')
  assert.equal(saved, 1)
  const team = s.context.project(room, game, 'p1').game.myAction.wolfTeam
  assert.equal(team.find(item => item.seat === 1).suggestedSeat, 2)
  assert.equal(team.find(item => item.seat === 1).selectedSeat, 0)
  assert.equal(s.context.project(room, game, 'p2').game.myAction, undefined)
  assert.equal(s.context.project(room, game, 'p4').game.myAction, undefined)
  assert.equal(JSON.stringify(s.context.project(room, game, 'p2')).includes('wolfTeam'), false)
  await assert.rejects(s.context.dispatch('suggestWolfTarget', { version: 1, targetSeat: 1 }, 'p2'), { code: 'FORBIDDEN' })
  await assert.rejects(s.context.dispatch('suggestWolfTarget', { version: 1, targetSeat: 1 }, 'p4'), { code: 'FORBIDDEN' })
  await assert.rejects(s.context.dispatch('suggestWolfTarget', { version: 1, targetSeat: 5 }, 'p0'), { code: 'BAD_TARGET' })
  await assert.rejects(s.context.dispatch('suggestWolfTarget', { version: 0, targetSeat: 1 }, 'p0'), { code: 'STALE_STATE' })
  await assert.rejects(s.context.dispatch('submitNightAction', { version: 1, targetSeat: 5 }, 'p0'), { code: 'BAD_TARGET' })
  await s.context.dispatch('submitNightAction', { version: 1, targetSeat: 2 }, 'p0')
  await s.context.dispatch('submitNightAction', { version: 1, targetSeat: 1 }, 'p1')
  assert.equal(game.night.cue, 'ACTION')
  const split = s.context.project(room, game, 'p0').game.myAction.wolfTeam
  assert.equal(split.find(item => item.seat === 1).selectedSeat, 2)
  assert.equal(split.find(item => item.seat === 2).selectedSeat, 1)
  await s.context.dispatch('submitNightAction', { version: 1, targetSeat: 2 }, 'p1')
  assert.equal(game.night.attackedSeat, 2)
  assert.equal(game.night.cue, 'CLOSE')
  await assert.rejects(s.context.dispatch('suggestWolfTarget', { version: 1, targetSeat: 1 }, 'p0'), { code: 'WRONG_PHASE' })
  assert.equal(s.context.project(room, game, 'p0').game.myAction, undefined)
})

test('night entry waits for living confirmations including non-owner, persists transition and skips dead players', async () => {
  const s = server(), db = vm.runInContext('db', s.context), writes = []
  db.command.set = value => value
  const roles = ['村民', '预言家', '狼人', '村民', '狼人', '村民']
  const room = { _id: 'room', version: 1, ownerId: 'p0', status: 'PLAYING', config: { total: 6, interval: 1, winMode: '屠城' }, members: roles.map((_, i) => ({ userId: `p${i}`, nickname: `玩家${i}`, seat: i + 1, alive: i < 4, isBot: i === 2 || i === 3 })) }
  const game = { _id: 'game', phase: 'DAY', day: 1, firstNightRevealed: true, publicResult: [], confirmedUserIds: [], night: {}, actions: {}, dayState: { stage: 'COMPLETE', resultText: '无人出局', nightConfirmations: { p4: true, obsolete: true } }, roles: Object.fromEntries(roles.map((role, i) => [`p${i}`, { role, alive: i < 4, abilities: {} }])) }
  s.context.getUser = async id => ({ _id: id })
  s.context.getRoomByUser = async () => room; s.context.getGame = async () => game; s.context.saveRoom = async () => room
  db.collection = () => ({ doc: () => ({ update: async ({ data }) => writes.push(clone(data)) }) })
  assert.equal(s.context.project(room, game, 'p4').game.dayView.submitted, true)
  await assert.rejects(s.context.dispatch('nextNight', { version: 1 }, 'p4'), { code: 'FORBIDDEN' })
  await s.context.dispatch('nextNight', { version: 1 }, 'p1')
  assert.equal(game.phase, 'DAY')
  assert.equal(s.context.project(room, game, 'p1').game.dayView.submitted, true)
  assert.equal(s.context.project(room, game, 'p0').game.dayView.submitted, false)
  await s.context.dispatch('nextNight', { version: 1 }, 'p0')
  assert.equal(game.phase, 'NIGHT'); assert.equal(game.day, 2)
  assert.equal(game.night.cue, 'START')
  assert.equal(writes[writes.length - 1].phase, 'NIGHT')
  assert.equal(writes[writes.length - 1].day, 2)
  // A dead room owner is not a required confirmation participant.
  game.phase = 'DAY'; game.roles.p0.alive = false
  game.dayState = { stage: 'COMPLETE', nightConfirmations: { p1: true } }
  s.context.runDayAutomation(game, room)
  assert.equal(game.phase, 'NIGHT')
})

test('sheriff candidates speak before voting; withdrawal never restores voting rights or leaks hidden deaths', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const room = { _id: 'room', version: 1, ownerId: 'p4', status: 'PLAYING', config: { interval: 1 }, members: Array.from({ length: 5 }, (_, i) => ({ userId: `p${i}`, seat: i + 1, nickname: `玩家${i}`, alive: i !== 0 })) }
  const game = { _id: 'game', day: 1, phase: 'DAY', firstNightRevealed: false, publicResult: [1], confirmedUserIds: [], roles: Object.fromEntries(room.members.map(item => [item.userId, { role: '村民', alive: item.alive }])), dayState: { stage: 'SHERIFF_SIGNUP', signup: {}, sheriffVotes: {}, candidates: [] } }
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game; s.context.saveRoom = async () => room
  db.collection = () => ({ doc: () => ({ update: async () => {} }) })
  for (let i = 0; i < 5; i++) await s.context.dispatch('sheriffSignup', { version: 1, join: i < 3 }, `p${i}`)
  assert.equal(game.dayState.stage, 'SHERIFF_SPEECH')
  assert.equal(game.dayState.speakerSeat, 1)
  assert.equal(s.context.project(room, game, 'p0').game.dayView.canFinishSpeech, true)
  assert.equal(s.context.project(room, game, 'p4').game.dayView.canFinishSpeech, false)
  await assert.rejects(s.context.dispatch('finishSpeech', { version: 1 }, 'p4'), { code: 'FORBIDDEN' })
  await s.context.dispatch('finishSpeech', { version: 1 }, 'p0')
  assert.equal(game.dayState.speakerSeat, 2)
  await s.context.dispatch('withdrawSheriff', { version: 1 }, 'p0')
  assert.equal(game.dayState.signup.p0, true)
  assert.equal(game.dayState.withdrawn.p0, true)
  await s.context.dispatch('finishSpeech', { version: 1 }, 'p1')
  s.advance(90000)
  s.context.runDayAutomation(game, room)
  assert.equal(game.dayState.stage, 'SHERIFF_VOTE')
  assert.deepEqual(Array.from(game.dayState.candidates), [2, 3])
  for (const id of ['p0', 'p1', 'p2']) {
    assert.equal(s.context.project(room, game, id).game.dayView.canSheriffVote, false)
    await assert.rejects(s.context.dispatch('sheriffVote', { version: 1, targetSeat: 2 }, id), { code: 'FORBIDDEN' })
  }
  await s.context.dispatch('sheriffVote', { version: 1, targetSeat: 2 }, 'p3')
  assert.equal(game.dayState.stage, 'SHERIFF_VOTE')
  await s.context.dispatch('sheriffVote', { version: 1, targetSeat: 2 }, 'p4')
  assert.equal(game.dayState.sheriffSeat, 2)
  assert.equal(game.dayState.stage, 'NIGHT_RESULT')
})

test('sheriff election handles all withdraw, sole candidate and no eligible voters without stalling', () => {
  for (const candidates of [[], [1], [1, 2]]) {
    const s = server()
    const room = { members: [{ userId: 'a', seat: 1, alive: true }, { userId: 'b', seat: 2, alive: true }] }
    const game = { day: 1, phase: 'DAY', firstNightRevealed: false, publicResult: [], roles: { a: { alive: true }, b: { alive: true } }, dayState: { candidates, signup: { a: true, b: true }, stage: 'SHERIFF_SPEECH' } }
    s.context.finishSheriffSpeeches(game, room)
    assert.equal(game.dayState.stage, 'NIGHT_RESULT')
    assert.equal(game.dayState.sheriffSeat, candidates.length === 1 ? 1 : 0)
  }
})

test('one-click readiness is owner-only in virtual test rooms and never seats players or readies real accounts', async () => {
  const s = server(), room = s.room()
  const { resolveIdentity } = require('../cloudfunctions/api/virtual-users')
  const identity = resolveIdentity('openid:owner', 'host', { VIRTUAL_TEST_ENABLED: 'true', VIRTUAL_TEST_OPENIDS: 'openid:owner' })
  room.status = 'WAITING'; room.gameId = ''; room.config = { total: 6 }; room.testScope = identity.testScope
  room.members[0] = { ...room.members[0], seat: 1, ready: false, openid: identity.openid, authOpenid: 'openid:owner' }
  room.members[1] = { ...room.members[1], seat: 2, ready: false, openid: `virtual:${identity.testScope}:player-1`, authOpenid: 'openid:owner' }
  room.members[2].seat = 3; room.members[2].ready = false
  room.members.push({ userId: 'unseated', nickname: '未入座', seat: 0, ready: false, openid: `virtual:${identity.testScope}:player-2`, authOpenid: 'openid:owner' })
  room.members.push({ userId: 'real', nickname: '真实用户', seat: 4, ready: false, openid: 'openid:real' })
  s.context.getUser = async id => ({ _id: id, testScope: identity.testScope }); s.context.getRoomByUser = async () => clone(s.room())
  await assert.rejects(s.context.dispatch('readyVirtualPlayers', { version: 7 }, 'guest'), { code: 'FORBIDDEN' })
  await assert.rejects(s.context.dispatch('readyVirtualPlayers', { version: 6 }, 'owner'), { code: 'STALE_STATE' })
  const view = await s.context.dispatch('readyVirtualPlayers', { version: 7 }, 'owner')
  assert.deepEqual(Array.from(view.members, item => item.ready), [true, true, false, false, false])
  assert.deepEqual(Array.from(view.members, item => item.seat), [1, 2, 3, 0, 4])
  assert.equal(view.status, 'WAITING')
  assert.equal(view.version, 8)
  assert.equal(s.signals.guest.version, 8)
  assert.equal(s.signals.owner._openid, 'openid:owner')
  s.room().status = 'PLAYING'
  await assert.rejects(s.context.dispatch('readyVirtualPlayers', { version: 8 }, 'owner'), { code: 'LOCKED' })
  s.context.getUser = async id => ({ _id: id, testScope: '' })
  await assert.rejects(s.context.dispatch('readyVirtualPlayers', { version: 8 }, 'owner'), { code: 'TEST_FORBIDDEN' })
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/room/room.wxml'), 'utf8')
  assert.match(template, /wx:if="\{\{isOwner && isVirtualTest && room.status === 'WAITING'\}\}"[^>]*bindtap="readyVirtualPlayers"/)
})

test('only owner can rotate waiting-room seats, wrapping last seat and syncing all members', async () => {
  const s = server(), room = s.room()
  room.status = 'WAITING'; room.gameId = ''; room.config = { total: 6 }; room.broadcastVersion = 0
  room.members[0].seat = 1; room.members[0].ready = true
  room.members[1].seat = 6; room.members[1].ready = true
  room.members[2].seat = 3; room.members[2].ready = true
  room.members.push({ userId: 'unseated', seat: 0, ready: false, nickname: '未入座' })
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => clone(s.room())
  await assert.rejects(s.context.dispatch('rotateSeats', { version: 7 }, 'guest'), { code: 'FORBIDDEN' })
  await assert.rejects(s.context.dispatch('rotateSeats', { version: 6 }, 'owner'), { code: 'STALE_STATE' })
  const view = await s.context.dispatch('rotateSeats', { version: 7 }, 'owner')
  assert.deepEqual(Array.from(view.members, item => item.seat), [2, 1, 4, 0])
  assert.deepEqual(Array.from(view.members, item => item.ready), [false, false, true, false])
  assert.equal(view.version, 8)
  for (const id of ['owner', 'guest', 'unseated']) assert.equal(s.signals[id].version, 8)
  await assert.rejects(s.context.dispatch('rotateSeats', { version: 7 }, 'owner'), { code: 'STALE_STATE' })
  for (let version = 8; version < 13; version++) await s.context.dispatch('rotateSeats', { version }, 'owner')
  assert.deepEqual(s.room().members.map(item => item.seat), [1, 6, 3, 0])
  s.room().status = 'PLAYING'
  await assert.rejects(s.context.dispatch('rotateSeats', { version: 13 }, 'owner'), { code: 'LOCKED' })
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/room/room.wxml'), 'utf8')
  assert.match(template, /wx:if="\{\{isOwner && room.status === 'WAITING'\}\}"[^>]*bindtap="rotateSeats"/)
})

test('vote reports stay private until round completion and show totals, voters and sheriff weight before confirmation', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const room = { _id: 'room', version: 1, ownerId: 'a', status: 'PLAYING', members: [{ userId: 'a', seat: 1, alive: true }, { userId: 'b', seat: 2, alive: true }, { userId: 'c', seat: 3, alive: true }] }
  const game = { _id: 'game', phase: 'DAY', day: 2, publicResult: [], confirmedUserIds: [], roles: { a: { alive: true }, b: { alive: true }, c: { alive: true } }, dayState: { stage: 'EXILE_VOTE', sheriffSeat: 1, exileVotes: {} } }
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game; s.context.saveRoom = async () => room
  let persisted
  db.collection = () => ({ doc: () => ({ update: async ({ data }) => { persisted = clone(data) } }) })
  await s.context.dispatch('exileVote', { version: 1, targetSeat: 2 }, 'a')
  assert.equal(s.context.project(room, game, 'b').game.dayView.voteResults.length, 0)
  await s.context.dispatch('exileVote', { version: 1, targetSeat: 2 }, 'b')
  assert.equal(s.context.project(room, game, 'c').game.dayView.voteResults.length, 0)
  const view = await s.context.dispatch('exileVote', { version: 1, targetSeat: 0 }, 'c')
  assert.equal(view.game.dayView.stage, 'COMPLETE')
  const result = view.game.dayView.voteResults[0]
  assert.equal(result.kind, 'EXILE')
  assert.equal(result.round, 1)
  assert.equal(result.totals[0].votes, 2.5)
  assert.deepEqual(Array.from(result.totals[0].voterSeats), [1, 2])
  assert.deepEqual(Array.from(result.totals[0].sheriffVoterSeats), [1])
  assert.deepEqual(Array.from(result.abstainedSeats), [3])
  assert.equal(JSON.stringify(s.context.project(room, game, 'b').game.dayView.voteResults), JSON.stringify(view.game.dayView.voteResults))
  assert.deepEqual(persisted.dayState.voteResults, clone(view.game.dayView.voteResults))
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/game/game.wxml'), 'utf8')
  assert.ok(template.indexOf('class="card day-flow vote-results"') < template.indexOf('bindtap="nextNight"'))
  assert.ok(template.indexOf('class="card day-flow vote-results"') < template.indexOf('bindtap="confirmFirstNightResult"'))
})

test('sheriff three-way tie starts PK speeches, then all players including withdrawn candidates can vote; repeated tie loses badge', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const room = { _id: 'room', version: 1, ownerId: 'p5', status: 'PLAYING', members: Array.from({ length: 6 }, (_, i) => ({ userId: `p${i}`, seat: i + 1, nickname: `玩家${i}`, alive: i !== 0 })) }
  const game = { _id: 'game', phase: 'DAY', day: 1, firstNightRevealed: false, publicResult: [1], confirmedUserIds: [], roles: Object.fromEntries(room.members.map(item => [item.userId, { alive: item.alive, role: '村民' }])), dayState: { stage: 'SHERIFF_VOTE', candidates: [1, 2, 3], sheriffSeat: 0, signup: { p0: true, p1: true, p2: true, p3: false, p4: false, p5: false }, withdrawn: {}, sheriffVotes: {} } }
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game; s.context.saveRoom = async () => room
  db.collection = () => ({ doc: () => ({ update: async () => {} }) })
  for (let i = 3; i < 6; i++) await s.context.dispatch('sheriffVote', { version: 1, targetSeat: i - 2 }, `p${i}`)
  assert.equal(game.dayState.stage, 'SHERIFF_PK_SPEECH')
  assert.deepEqual(Array.from(game.dayState.pkCandidates), [1, 2, 3])
  assert.equal(game.dayState.sheriffRound, 2)
  assert.equal(game.dayState.voteResults.length, 1)
  assert.equal(game.dayState.voteResults[0].totals.length, 3)
  assert.equal(game.dayState.voteResults[0].round, 1)
  assert.equal(Object.keys(game.dayState.sheriffVotes).length, 0)
  assert.equal(game.firstNightRevealed, false)
  assert.equal(s.context.project(room, game, 'p0').game.dayView.canFinishSpeech, true)
  await assert.rejects(s.context.dispatch('finishSpeech', { version: 1 }, 'p5'), { code: 'FORBIDDEN' })
  for (let i = 0; i < 3; i++) await s.context.dispatch('finishSpeech', { version: 1 }, `p${i}`)
  assert.equal(game.dayState.stage, 'SHERIFF_VOTE')
  assert.equal(s.context.project(room, game, 'p0').game.dayView.canSheriffVote, true)
  // A previously withdrawn player is eligible in round two, unlike round one.
  game.dayState.signup.p3 = true; game.dayState.withdrawn.p3 = true
  assert.equal(s.context.project(room, game, 'p3').game.dayView.canSheriffVote, true)
  await assert.rejects(s.context.dispatch('sheriffVote', { version: 1, targetSeat: 4 }, 'p3'), { code: 'BAD_TARGET' })
  for (let i = 0; i < 6; i++) await s.context.dispatch('sheriffVote', { version: 1, targetSeat: i % 3 + 1 }, `p${i}`)
  assert.equal(game.dayState.stage, 'NIGHT_RESULT')
  assert.equal(game.dayState.sheriffSeat, 0)
  assert.match(game.dayState.resultText, /警徽流失/)
  assert.equal(game.dayState.voteResults.length, 2)
  assert.equal(game.dayState.voteResults[1].round, 2)
  assert.equal(game.dayState.voteResults[0].totals[0].votes, 1)
  assert.equal(game.firstNightRevealed, true)
})

test('exile votes weight sheriff at 1.5, PK only tied players, and second ties do not eliminate anyone', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const room = { _id: 'room', version: 1, ownerId: 'p5', status: 'PLAYING', members: Array.from({ length: 6 }, (_, i) => ({ userId: `p${i}`, seat: i + 1, alive: true })) }
  const game = { _id: 'game', phase: 'DAY', day: 2, publicResult: [], confirmedUserIds: [], roles: Object.fromEntries(room.members.map(item => [item.userId, { alive: true, role: '村民' }])), dayState: { stage: 'EXILE_VOTE', sheriffSeat: 1, exileVotes: { p0: 2, p1: 2, p2: 2, p3: 3, p4: 3, p5: 3 } } }
  assert.equal(s.context.project(room, game, 'p0').game.dayView.myVoteWeight, 1.5)
  s.context.resolveExileVote(game, room)
  assert.equal(game.roles.p1.alive, false)
  assert.equal(game.roles.p2.alive, true)
  assert.equal(game.dayState.stage, 'COMPLETE')
  game.roles.p1.alive = true; room.members[1].alive = true
  game.dayState = { stage: 'EXILE_VOTE', sheriffSeat: 1, exileVotes: { p0: 0, p1: 2, p2: 2, p3: 3, p4: 3, p5: 0 } }
  s.context.resolveExileVote(game, room)
  assert.equal(game.dayState.stage, 'EXILE_PK_SPEECH')
  assert.equal(game.dayState.speakerSeat, 2)
  assert.deepEqual(Array.from(game.dayState.pkCandidates), [2, 3])
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game; s.context.saveRoom = async () => room
  db.collection = () => ({ doc: () => ({ update: async () => {} }) })
  await s.context.dispatch('finishSpeech', { version: 1 }, 'p1')
  s.advance(90000); s.context.runDayAutomation(game, room)
  assert.equal(game.dayState.stage, 'EXILE_VOTE')
  assert.deepEqual(Array.from(s.context.project(room, game, 'p0').game.dayView.targets, item => item.seat), [2, 3])
  await assert.rejects(s.context.dispatch('exileVote', { version: 1, targetSeat: 4 }, 'p0'), { code: 'BAD_TARGET' })
  const votes = [0, 2, 2, 3, 3, 0]
  for (let i = 0; i < votes.length; i++) await s.context.dispatch('exileVote', { version: 1, targetSeat: votes[i] }, `p${i}`)
  assert.equal(game.dayState.stage, 'COMPLETE')
  assert.match(game.dayState.resultText, /再次平票/)
  assert.ok(Object.values(game.roles).every(role => role.alive))
})

test('withdrawal immediately elects the last candidate, including withdrawal by a non-speaker', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const room = { _id: 'room', version: 1, ownerId: 'a', status: 'PLAYING', members: [{ userId: 'a', seat: 1 }, { userId: 'b', seat: 2 }, { userId: 'c', seat: 3 }] }
  const game = { _id: 'game', phase: 'DAY', day: 1, firstNightRevealed: false, publicResult: [], confirmedUserIds: [], roles: { a: { alive: true }, b: { alive: true }, c: { alive: true } }, dayState: { stage: 'SHERIFF_SPEECH', candidates: [1, 2], signup: { a: true, b: true, c: false }, withdrawn: {}, speechQueue: [1, 2], speakerSeat: 1, speechDeadline: 91000 } }
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game; s.context.saveRoom = async () => room
  db.collection = () => ({ doc: () => ({ update: async () => {} }) })
  await assert.rejects(s.context.dispatch('withdrawSheriff', { version: 1 }, 'c'), { code: 'FORBIDDEN' })
  await s.context.dispatch('withdrawSheriff', { version: 1 }, 'b')
  assert.equal(game.dayState.sheriffSeat, 1)
  assert.equal(game.dayState.stage, 'NIGHT_RESULT')
  assert.equal(game.dayState.speechDeadline, 0)
  assert.equal(game.dayState.speechQueue.length, 0)
  assert.equal(game.dayState.signup.b, true)
  assert.equal(game.dayState.withdrawn.b, true)
  assert.equal(game.sheriffElectionDone, true)
  const single = { ...game, firstNightRevealed: false, dayState: { stage: 'SHERIFF_SIGNUP', signup: { a: false, b: true, c: false } } }
  s.context.resolveSignup(single, room)
  assert.equal(single.dayState.sheriffSeat, 2)
  assert.equal(single.dayState.stage, 'NIGHT_RESULT')
})

test('speech extensions are caller-only, twice per game, persistent across rounds and version guarded', async () => {
  const s = server(), db = vm.runInContext('db', s.context), signals = []
  db.command.set = value => value
  const room = { _id: 'room', gameId: 'game', version: 1, ownerId: 'owner', members: [
    { userId: 'owner', openid: 'openid:owner', seat: 1 }, { userId: 'speaker', openid: 'openid:speaker', seat: 2 },
  ] }
  const game = { _id: 'game', day: 2, phase: 'DAY', publicResult: [], confirmedUserIds: [], roles: { owner: { alive: true }, speaker: { alive: true } }, dayState: { stage: 'SPEECH', speakerSeat: 2, speechDeadline: 91000 } }
  db.runTransaction = async fn => fn({ collection: name => ({ doc: () => {
    if (name === 'room_signals') return { set: async ({ data }) => signals.push(data) }
    const value = name === 'rooms' ? room : game
    return { get: async () => ({ data: clone(value) }), update: async ({ data }) => Object.assign(value, clone(data)) }
  } }) })
  await assert.rejects(s.context.extendSpeech('room', 'owner', 1), { code: 'FORBIDDEN' })
  const view = await s.context.extendSpeech('room', 'speaker', 1)
  assert.equal(game.dayState.speechDeadline, 121000)
  assert.equal(view.game.dayView.speechExtensionsRemaining, 1)
  assert.equal(signals.length, 2)
  await assert.rejects(s.context.extendSpeech('room', 'speaker', 1), { code: 'STALE_STATE' })
  game.day = 3
  game.dayState = { stage: 'SPEECH', speakerSeat: 2, speechDeadline: 91000 }
  await s.context.extendSpeech('room', 'speaker', 2)
  assert.equal(game.speechExtensions.speaker, 2)
  await assert.rejects(s.context.extendSpeech('room', 'speaker', 3), { code: 'NO_SPEECH_EXTENSION' })
  game.dayState.speakerSeat = 1
  s.advance(120000)
  await assert.rejects(s.context.extendSpeech('room', 'owner', 3), { code: 'SPEECH_EXPIRED' })
  assert.equal(game.speechExtensions.owner, undefined)
  game.dayState.speechDeadline = 181000
  await s.context.extendSpeech('room', 'owner', 3)
  assert.equal(game.speechExtensions.owner, 1)
  game.roles.owner.alive = false
  await assert.rejects(s.context.extendSpeech('room', 'owner', 4), { code: 'FORBIDDEN' })
  game.day = 1; game.firstNightRevealed = false; game.publicResult = [1]
  game.dayState.stage = 'SHERIFF_SPEECH'
  await s.context.extendSpeech('room', 'owner', 4)
  assert.equal(game.speechExtensions.owner, 2)
  assert.equal(game.dayState.speechDeadline, 241000)
})

test('room owner cannot end another player speech, while speaker and deadline remain valid', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const room = { _id: 'room', version: 1, ownerId: 'owner', status: 'PLAYING', members: [{ userId: 'owner', nickname: '房主', seat: 1 }, { userId: 'speaker', nickname: '玩家', seat: 2 }] }
  const game = { _id: 'game', phase: 'DAY', day: 2, publicResult: [], confirmedUserIds: [], actions: {}, night: {}, dayState: { stage: 'SPEECH', speakerSeat: 2, speechQueue: [2, 1], speechDeadline: 91000, exileVotes: {} }, roles: { owner: { alive: true, role: '狼人' }, speaker: { alive: true, role: '村民' } } }
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game; s.context.saveRoom = async () => room
  let writes = 0
  db.collection = () => ({ doc: () => ({ update: async () => { writes++ } }) })
  assert.equal(s.context.project(room, game, 'owner').game.dayView.canFinishSpeech, false)
  assert.equal(s.context.project(room, game, 'speaker').game.dayView.canFinishSpeech, true)
  await assert.rejects(s.context.dispatch('finishSpeech', { version: 1 }, 'owner'), { code: 'FORBIDDEN' })
  assert.equal(writes, 0)
  assert.equal(game.dayState.speakerSeat, 2)
  await s.context.dispatch('finishSpeech', { version: 1 }, 'speaker')
  assert.equal(game.dayState.speakerSeat, 1)
  assert.equal(s.context.project(room, game, 'owner').game.dayView.canFinishSpeech, true)
  s.advance(game.dayState.speechDeadline - s.context.Date.now())
  s.context.runDayAutomation(game, room)
  assert.equal(game.dayState.stage, 'EXILE_VOTE')
})

test('unannounced first-night casualties still confirm dawn and do not leak death through eligibility', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const room = { _id: 'room', ownerId: 'living', version: 1, status: 'PLAYING', config: { total: 2, interval: 1 }, members: [
    { userId: 'living', seat: 1, nickname: '甲', alive: true }, { userId: 'dead', seat: 2, nickname: '乙', alive: false },
  ] }
  const game = { _id: 'game', day: 1, phase: 'DAWN', firstNightRevealed: false, confirmedUserIds: [], publicResult: [2], night: {}, actions: {}, roles: {
    living: { alive: true, role: '狼人' }, dead: { alive: false, role: '村民' },
  } }
  s.context.getUser = async id => ({ _id: id }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game; s.context.saveRoom = async () => room
  db.collection = () => ({ doc: () => ({ update: async () => {} }) })
  for (const id of ['living', 'dead']) {
    const view = s.context.project(room, game, id)
    assert.equal(view.game.totalCount, 2)
    assert.equal(view.game.confirmationRequired, true)
    assert.equal(view.game.myConfirmed, false)
    assert.equal(view.members[1].alive, true)
    assert.equal(view.game.publicResult.length, 0)
  }
  await s.context.dispatch('confirmDawn', { version: 1 }, 'living')
  assert.equal(game.phase, 'DAWN')
  await s.context.dispatch('confirmDawn', { version: 1 }, 'dead')
  assert.equal(game.phase, 'DAY')
  assert.equal(game.dayState.stage, 'SHERIFF_SIGNUP')
  assert.equal(game.roles.dead.alive, false)
  assert.equal(s.context.project(room, game, 'dead').game.confirmationRequired, true)
  game.firstNightRevealed = true
  game.dayState = { stage: 'NIGHT_RESULT', resultConfirmations: {} }
  const announced = s.context.project(room, game, 'dead')
  assert.equal(announced.members[1].alive, false)
  assert.equal(announced.game.confirmationRequired, false)
  assert.equal(announced.game.totalCount, 1)
  await assert.rejects(s.context.dispatch('confirmFirstNightResult', { version: 1 }, 'dead'), { code: 'FORBIDDEN' })
})

test('confirmation stages wait only for living players and ignore stale/dead confirmations', async () => {
  const s = server()
  const room = { _id: 'room', ownerId: 'living', version: 1, status: 'PLAYING', config: { total: 3, interval: 1 }, members: [
    { userId: 'living', seat: 1, nickname: '甲', alive: true }, { userId: 'dead', seat: 2, nickname: '乙', alive: false }, { userId: 'dead-bot', seat: 3, nickname: '丙', alive: false, isBot: true },
  ] }
  const game = { _id: 'game', day: 2, phase: 'DAWN', confirmedUserIds: ['dead', 'obsolete'], publicResult: [2], night: {}, actions: {}, roles: {
    living: { alive: true, role: '狼人', abilities: {} }, dead: { alive: false, role: '村民', abilities: {} }, 'dead-bot': { alive: false, role: '预言家', abilities: {} },
  } }
  const view = s.context.project(room, game, 'dead')
  assert.equal(view.game.totalCount, 1)
  assert.equal(view.game.confirmedCount, 0)
  assert.equal(view.game.confirmationRequired, false)
  assert.equal(view.game.myConfirmed, true)
  s.context.runBots(game, room)
  assert.equal(game.phase, 'DAWN')
  assert.ok(!game.confirmedUserIds.includes('dead-bot'))
  game.confirmedUserIds.push('living')
  s.context.runBots(game, room)
  assert.equal(game.phase, 'DAY')
  game.dayState = { stage: 'NIGHT_RESULT', resultConfirmations: { dead: true, obsolete: true }, resultText: '首夜结果' }
  s.context.runDayAutomation(game, room)
  assert.equal(game.dayState.stage, 'NIGHT_RESULT')
  assert.equal(s.context.project(room, game, 'dead').game.dayView.submitted, true)
  game.dayState.resultConfirmations.living = true
  s.context.runDayAutomation(game, room)
  assert.equal(game.dayState.stage, 'SPEECH_ORDER')
  game.phase = 'ROLE_REVEAL'; game.confirmedUserIds = ['living']
  s.context.runBots(game, room)
  assert.equal(game.phase, 'NIGHT')
  const db = vm.runInContext('db', s.context)
  s.context.getUser = async () => ({ _id: 'dead' }); s.context.getRoomByUser = async () => room; s.context.getGame = async () => game
  db.collection = () => { throw new Error('dead player must not write confirmation') }
  for (const action of ['confirmRole', 'confirmDawn', 'confirmFirstNightResult']) {
    await assert.rejects(s.context.dispatch(action, { version: 1 }, 'dead'), { code: 'FORBIDDEN' })
  }
})

test('wolf can target all living players, seer cannot self-check, with backend validation matching targets', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  db.command.set = value => value
  const members = ['狼人', '狼人', '预言家', '女巫', '村民', '村民'].map((role, i) => ({ userId: `p${i}`, seat: i + 1, nickname: `玩家${i}`, alive: true }))
  const room = { _id: 'room', ownerId: 'p0', members, version: 1, config: { total: 6, interval: 1 }, status: 'PLAYING' }
  const game = { _id: 'game', day: 1, phase: 'NIGHT', nightStage: 'WEREWOLF', stageReadyAt: 0, night: { cue: 'ACTION' }, actions: {}, confirmedUserIds: [], publicResult: [], roles: Object.fromEntries(['狼人', '狼人', '预言家', '女巫', '村民', '村民'].map((role, i) => [`p${i}`, { role, alive: true, abilities: {} }])) }
  s.context.getUser = async id => ({ _id: id })
  s.context.getRoomByUser = async () => room
  s.context.getGame = async () => game
  s.context.saveRoom = async () => room
  db.collection = () => ({ doc: () => ({ update: async () => {} }) })
  const wolfTargets = s.context.project(room, game, 'p0').game.myAction.targets.map(item => item.seat)
  assert.deepEqual(Array.from(wolfTargets), [1, 2, 3, 4, 5, 6])
  await s.context.dispatch('suggestWolfTarget', { version: 1, targetSeat: 1 }, 'p0')
  assert.equal(game.night.wolfSuggestions.p0, 1)
  await s.context.dispatch('suggestWolfTarget', { version: 1, targetSeat: 2 }, 'p0')
  assert.equal(game.night.wolfSuggestions.p0, 2)
  await s.context.dispatch('submitNightAction', { version: 1, targetSeat: 2 }, 'p0')
  assert.equal(game.actions['1:NIGHT:WEREWOLF:p0'].targetSeat, 2)
  await s.context.dispatch('submitNightAction', { version: 1, targetSeat: 1 }, 'p0')
  assert.equal(game.actions['1:NIGHT:WEREWOLF:p0'].targetSeat, 1)
  game.nightStage = 'SEER'
  const seerTargets = s.context.project(room, game, 'p2').game.myAction.targets.map(item => item.seat)
  assert.ok(!seerTargets.includes(3))
  await assert.rejects(s.context.dispatch('submitNightAction', { version: 1, targetSeat: 3 }, 'p2'), { code: 'BAD_TARGET' })
  await s.context.dispatch('submitNightAction', { version: 1, targetSeat: 4 }, 'p2')
  assert.equal(game.actions['1:NIGHT:SEER:p2'].targetSeat, 4)
})

test('first-day explosion reveals night casualties before transitioning without audio callbacks', () => {
  const s = server()
  const roles = ['狼人', '狼人', '预言家', '女巫', '村民', '村民', '村民', '村民']
  const room = { _id: 'room', ownerId: 'p0', version: 1, status: 'PLAYING', config: { total: 8, interval: 1, winMode: '屠城' }, members: roles.map((_, i) => ({ userId: `p${i}`, seat: i + 1, nickname: `玩家${i}`, alive: i !== 7 })) }
  const game = { _id: 'game', phase: 'DAY', day: 1, firstNightRevealed: false, sheriffElectionDone: false, dayState: { stage: 'SHERIFF_SIGNUP' }, confirmedUserIds: [], publicResult: [8], actions: {}, night: {}, roles: Object.fromEntries(roles.map((role, i) => [`p${i}`, { role, alive: i !== 7, abilities: {} }])) }
  s.context.explodeWolf(game, room, 'p0')
  assert.equal(game.phase, 'DAY'); assert.equal(game.day, 1)
  assert.equal(game.firstNightRevealed, true)
  assert.equal(game.dayState.stage, 'NIGHT_RESULT')
  assert.deepEqual(game.publicResult, [8])
  const view = s.context.project(room, game, 'p1')
  assert.equal(view.game.dayView.canExplode, false)
  const announcement = require(path.join(build, 'miniprogram/services/announcements.js')).announcementFor(view)
  assert.equal(announcement.name, 'first-result:8')
  s.context.runDayAutomation(game, room)
  assert.equal(game.phase, 'DAY')
  s.advance(game.stageReadyAt - s.context.Date.now())
  s.context.runDayAutomation(game, room)
  assert.equal(game.phase, 'NIGHT'); assert.equal(game.day, 2)
  assert.equal(game.night.cue, 'START')
  assert.deepEqual(clone(game.publicResult), [])
  // A deciding explosion still reveals the night result before showing the winner.
  const ending = { ...game, phase: 'DAY', day: 1, firstNightRevealed: false, publicResult: [], dayState: { stage: 'SHERIFF_VOTE' } }
  ending.roles.p1.alive = true
  s.context.explodeWolf(ending, room, 'p1')
  assert.equal(ending.phase, 'DAY')
  assert.equal(ending.dayState.resultText, '首夜是一个平安夜')
  s.advance(ending.stageReadyAt - s.context.Date.now())
  s.context.runDayAutomation(ending, room)
  assert.equal(ending.phase, 'FINISHED')
  assert.equal(room.status, 'FINISHED')
})

test('first-night result audio plays a public-only sequence and stops queued clips', () => {
  let ended, error
  const played = [], audio = { src: '', obeyMuteSwitch: false, stop() {}, play() { played.push(this.src) }, onEnded: fn => { ended = fn }, onError: fn => { error = fn } }
  const context = { exports: {}, wx: { createInnerAudioContext: () => audio, showToast() {} } }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/announcer.js'), 'utf8'), context)
  context.exports.playAnnouncement('first-result:1,16')
  ended(); ended(); ended()
  assert.deepEqual(played.map(source => path.basename(source)), ['first-night-result.mp3', 'seat-1.mp3', 'seat-16.mp3', 'left-game.mp3'])
  context.exports.playAnnouncement('first-result:')
  assert.equal(path.basename(played[4]), 'peaceful-night.mp3')
  context.exports.playAnnouncement('first-result:2,3')
  context.exports.stopAnnouncement()
  const count = played.length; ended(); assert.equal(played.length, count)
  context.exports.playAnnouncement('first-result:2,3'); error()
  const countAfterError = played.length; ended(); assert.equal(played.length, countAfterError)
  for (const source of played) assert.ok(fs.existsSync(path.join(root, 'miniprogram', source)))
})

test('transaction operations are sequential across room saves, transfers and owner dissolution', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  let room = clone(s.room()), busy = false
  const signals = {}, users = Object.fromEntries(room.members.filter(item => !item.isBot).map(item => [item.userId, { openid: `openid:${item.userId}`, currentRoomId: 'room' }]))
  const operations = []
  const operation = async (label, fn) => {
    assert.equal(busy, false, `overlapping transaction operation: ${label}`)
    busy = true
    try { await new Promise(resolve => setImmediate(resolve)); operations.push(label); return fn() }
    finally { busy = false }
  }
  db.runTransaction = fn => fn({ collection: name => ({ doc: id => {
    if (name === 'rooms') return {
      get: () => operation('room:get', () => ({ data: clone(room) })),
      update: ({ data }) => operation('room:update', () => { Object.assign(room, clone(data)) }),
      remove: () => operation('room:remove', () => { room = null }),
    }
    if (name === 'users') return {
      get: () => operation(`user:get:${id}`, () => ({ data: clone(users[id]) })),
      update: ({ data }) => operation(`user:update:${id}`, () => { Object.assign(users[id], data) }),
    }
    if (name === 'cleanup_tasks') return { set: async () => {} }
    assert.equal(name, 'room_signals')
    return { set: ({ data }) => operation(`signal:set:${id}`, () => { signals[id] = clone(data) }) }
  } }) })
  const saved = await s.context.saveRoom(clone(room), { members: clone(room.members) })
  assert.equal(saved.version, 8)
  assert.equal(signals.owner.version, 8)
  assert.equal(signals.guest.version, 8)
  await s.context.updateBroadcast('room', 'owner', 'transferBroadcast', { userId: 'guest', broadcastVersion: 0 })
  assert.equal(signals.guest.broadcastVersion, 1)
  await s.context.clearRoomSignals(clone(room))
  assert.equal(signals.owner.roomId, '')
  await s.context.dissolveForOwner(clone(room), { _id: 'owner' })
  assert.equal(room, null)
  assert.equal(users.owner.currentRoomId, '')
  assert.equal(users.guest.currentRoomId, '')
  assert.equal(operations[operations.length - 1], 'room:remove')
})

test('missing WeChat identity is rejected before any user lookup', async () => {
  const s = server()
  await assert.rejects(s.context.getUser(undefined), { code: 'UNAUTHENTICATED' })
  await assert.rejects(s.context.getUser(''), { code: 'UNAUTHENTICATED' })
})

test('deleted rooms repair stale user pointers, but errors and concurrent room changes do not', async () => {
  const s = server(), db = vm.runInContext('db', s.context)
  let rooms = [], failure = false, pointer = 'deleted-room', writes = 0
  db.collection = () => ({ where: () => ({ limit: () => ({ get: async () => { if (failure) throw new Error('network'); return { data: rooms } } }) }) })
  db.runTransaction = fn => fn({ collection: name => ({ doc: id => ({ get: async () => ({ data: name === 'rooms' ? rooms.find(room => room._id === id) : { currentRoomId: pointer } }), update: async ({ data }) => { pointer = data.currentRoomId; writes++ } }) }) })
  const user = { _id: 'owner', currentRoomId: 'deleted-room' }
  assert.equal(await s.context.getRoomByUser(user), null)
  assert.equal(user.currentRoomId, '')
  assert.equal(pointer, '')
  assert.equal(writes, 1)
  pointer = 'live-room'; user.currentRoomId = 'live-room'
  rooms = [{ _id: 'live-room', members: [{ userId: 'owner' }] }]
  assert.equal((await s.context.getRoomByUser(user))._id, 'live-room')
  assert.equal(writes, 1)
  failure = true
  await assert.rejects(s.context.getRoomByUser(user), /network/)
  assert.equal(pointer, 'live-room'); assert.equal(writes, 1)
  failure = false; rooms = []; pointer = 'new-room'
  await assert.rejects(s.context.getRoomByUser(user), { code: 'STALE_STATE' })
  assert.equal(pointer, 'new-room'); assert.equal(writes, 1)
  pointer = 'live-room'; rooms = [{ _id: 'live-room', members: [{ userId: 'other' }] }]
  assert.equal(await s.context.getRoomByUser(user), null)
  assert.equal(pointer, '')
})

test('virtual accounts have separate stored IDs, nicknames and room pointers across switches', async () => {
  const s = server(), records = []
  const db = vm.runInContext('db', s.context)
  db.collection = name => {
    assert.equal(name, 'users')
    return {
      where: query => ({ limit: () => ({ get: async () => ({ data: records.filter(row => row.openid === query.openid).map(clone) }) }) }),
      add: async ({ data }) => { const id = `user-${records.length + 1}`; records.push({ ...clone(data), _id: id }); return { _id: id } },
      doc: id => ({ get: async () => ({ data: records.find(row => row._id === id) }), set: async ({ data }) => { records.push({ ...clone(data), _id: id }) }, update: async ({ data }) => Object.assign(records.find(row => row._id === id), data) }),
    }
  }
  db.runTransaction = fn => fn(db)
  const host = await s.context.getUser('virtual:scope:host', 'scope')
  const guest = await s.context.getUser('virtual:scope:player-1', 'scope')
  assert.notEqual(host._id, guest._id)
  assert.equal(host.nickname, '虚拟房主')
  assert.equal(guest.nickname, '虚拟玩家1')
  records[0].currentRoomId = 'host-room'
  assert.equal((await s.context.getUser('virtual:scope:host', 'scope')).currentRoomId, 'host-room')
  assert.equal((await s.context.getUser('virtual:scope:player-1', 'scope')).currentRoomId, '')
  records[1].nickname = '玩家1234'
  assert.equal((await s.context.getUser('virtual:scope:player-1', 'scope')).nickname, '虚拟玩家1')
  records[1].nickname = '自己取的名字'
  assert.equal((await s.context.getUser('virtual:scope:player-1', 'scope')).nickname, '自己取的名字')
  await assert.rejects(s.context.getUser('virtual:scope:host', 'wrong-scope'), { code: 'IDENTITY_MISMATCH' })
})

test('homepage exit invalidates pending snapshots and locks during confirmation', async () => {
  let page, finishLoad, modal, exits = 0
  const context = { exports: {}, Error, wx: { showModal: options => {
    for (const key of ['confirmText', 'cancelText']) if (options[key]) assert.ok([...options[key]].length <= 4, `${key} exceeds WeChat's four-character limit`)
    modal = options
  }, showLoading() {}, hideLoading() {}, showToast() {} },
    Page: value => { page = value; page.setData = data => Object.assign(page.data, data) },
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('api/client') ? { api: { session: () => new Promise(resolve => { finishLoad = resolve }), exitRoom: async () => { exits++; return { profile: { id: 'owner', nickname: '甲' }, room: null } } }, showError() {} }
      : name.includes('virtual-users') ? { virtualSlots: ['host'], supportsVirtualUsers: () => true } : {},
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/index/index.js'), 'utf8'), context)
  page.data.hasRoom = true
  const pending = page.load()
  page.exitRoom()
  assert.equal(page.data.exitingRoom, true)
  page.exitRoom()
  await modal.success({ confirm: true })
  assert.equal(exits, 1)
  assert.equal(page.data.hasRoom, false)
  finishLoad({ profile: { id: 'owner', nickname: '甲' }, room: { code: '123456' } })
  await pending
  assert.equal(page.data.hasRoom, false)
  assert.equal(page.data.exitingRoom, false)
})

test('exit modal cancellation and failure unlock the button without submitting exit', async () => {
  let page, modal, exits = 0, refreshes = 0, message = ''
  const context = { exports: {}, Error, console: { warn() {} }, wx: { showModal: options => { modal = options } },
    Page: value => { page = value; page.setData = data => Object.assign(page.data, data) },
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('api/client') ? { api: { exitRoom: async () => { exits++ } }, showError: error => { message = error.message } } : {},
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/index/index.js'), 'utf8'), context)
  page.data.hasRoom = true; page.load = () => { refreshes++ }
  page.exitRoom()
  assert.equal(modal.confirmText, '确认退出')
  await modal.success({ confirm: false })
  assert.equal(page.data.exitingRoom, false)
  assert.equal(exits, 0)
  page.exitRoom()
  modal.fail({ errMsg: 'showModal:fail test' })
  assert.equal(page.data.exitingRoom, false)
  assert.equal(exits, 0)
  assert.match(message, /showModal:fail test/)
  assert.equal(refreshes, 2)
})

test('home exit has a standalone button and all explicit exit actions share server behavior', async () => {
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/index/index.wxml'), 'utf8')
  assert.match(template, /<button class="exit-room"[^>]*bindtap="exitRoom"/)
  assert.doesNotMatch(template, /class="resume card" bindtap=/)
  assert.doesNotMatch(template, /bindchange="switchTestUser"/)
  assert.match(template, /<test-user-switch disabled="\{\{switchingUser \|\| exitingRoom\}\}"/)
  const s = server(), db = vm.runInContext('db', s.context)
  const user = { _id: 'guest', openid: 'guest', nickname: '乙', currentRoomId: 'room' }
  const room = { _id: 'room', ownerId: 'owner', status: 'WAITING', members: [{ userId: 'owner' }, { userId: 'guest' }] }
  s.context.getUser = async () => clone(user)
  s.context.getRoomByUser = async () => clone(room)
  let saves = 0, clears = 0
  s.context.saveRoom = async (_, update) => { saves++; assert.deepEqual(Array.from(update.members, item => item.userId), ['owner']) }
  db.collection = () => ({ doc: () => ({ update: async ({ data }) => { assert.equal(data.currentRoomId, ''); clears++ } }) })
  for (const action of ['exitRoom', 'forceLeaveRoom', 'leaveRoom']) {
    assert.equal((await s.context.dispatch(action, {}, 'guest')).room, null)
  }
  assert.equal(saves, 3); assert.equal(clears, 3)
  await assert.rejects(s.context.dispatch('dissolveRoom', {}, 'guest'), { code: 'FORBIDDEN' })
  s.context.saveRoom = async () => { throw Object.assign(new Error('stale'), { code: 'STALE_STATE' }) }
  await assert.rejects(s.context.dispatch('exitRoom', {}, 'guest'), { code: 'STALE_STATE' })
  assert.equal(clears, 3)
})

test('owner dissolution removes room, clears only matching pointers and invalidates members atomically', async () => {
  const s = server(), db = vm.runInContext('db', s.context), signals = {}, updates = []
  const room = { _id: 'room', ownerId: 'owner', version: 5, gameId: 'game', members: [{ userId: 'owner', openid: 'real-owner' }, { userId: 'guest', openid: 'real-guest' }] }
  let removed = false
  db.runTransaction = async fn => fn({ collection: name => ({ doc: id => {
    if (name === 'rooms') return { get: async () => ({ data: clone(room) }), remove: async () => { removed = true } }
    if (name === 'users') return { get: async () => ({ data: { currentRoomId: id === 'owner' ? 'room' : 'new-room' } }), update: async ({ data }) => updates.push({ id, data }) }
    if (name === 'cleanup_tasks') return { set: async () => {} }
    assert.equal(name, 'room_signals')
    return { set: async ({ data }) => { signals[id] = data } }
  } }) })
  assert.equal(await s.context.dissolveForOwner(room, { _id: 'owner' }), 'game')
  assert.equal(removed, true)
  assert.deepEqual(updates.map(item => item.id), ['owner'])
  assert.equal(signals.owner.roomId, '')
  assert.equal(signals.guest.roomId, '')
  assert.equal(signals.owner.version, 6)
  removed = false; updates.length = 0
  await assert.rejects(s.context.dissolveForOwner(room, { _id: 'guest' }), { code: 'FORBIDDEN' })
  assert.equal(removed, false)
  assert.equal(updates.length, 0)
})

test('lobby separates guest permissions and seat snapshots from owner', async () => {
  let page, starts = 0
  const context = { exports: {}, Date, wx: {},
    Page: value => { page = value; page.setData = data => Object.assign(page.data, data) },
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('api/client') ? { api: { startGame: async () => { starts++ } } } : {},
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/room/room.js'), 'utf8'), context)
  page.visible = true; page.data.myId = 'guest'
  const room = { id: 'room', ownerId: 'owner', status: 'WAITING', version: 1, config: { total: 2 }, broadcast: { version: 0 }, members: [{ userId: 'owner', nickname: '甲', seat: 1, ready: true }, { userId: 'guest', nickname: '乙', seat: 2, ready: true }] }
  page.applyRoom(room)
  assert.equal(page.data.isOwner, false)
  assert.equal(page.data.mySeat, 2)
  assert.equal(page.data.seats[0].member.userId, 'owner')
  await page.start()
  assert.equal(starts, 0)
  page.applyRoom({ ...room, version: 2, members: room.members.map(member => ({ ...member, seat: member.seat === 1 ? 2 : 1 })) })
  assert.equal(page.data.mySeat, 1)
  assert.equal(page.data.seats[1].member.userId, 'owner')
  page.applyRoom(room)
  assert.equal(page.data.mySeat, 1)
  page.data.myId = ''; page.data.room = null
  page.applyRoom({ ...room, ownerId: '' })
  assert.equal(page.data.isOwner, false)
})

test('default owner, device exclusion, release and expiry affect only broadcast facts', async () => {
  const s = server()
  assert.equal(s.context.broadcastView(s.room()).userId, 'owner')
  const first = { sessionId: 'owner_device_00001' }
  const second = { sessionId: 'owner_device_00002' }
  assert.equal((await s.call('guest', 'heartbeatBroadcast', first)).granted, false)
  assert.equal((await s.call('owner', 'heartbeatBroadcast', first)).granted, true)
  assert.equal((await s.call('owner', 'heartbeatBroadcast', second)).granted, false)
  await s.call('owner', 'releaseBroadcast', second)
  assert.equal(s.context.broadcastView(s.room()).online, true)
  s.advance(10001)
  assert.equal(s.context.broadcastView(s.room()).online, false)
  assert.equal((await s.call('owner', 'heartbeatBroadcast', second)).granted, true)
  await s.call('owner', 'releaseBroadcast', first)
  assert.equal(s.context.broadcastView(s.room()).online, true)
  const allowed = new Set(['broadcastSession', 'broadcastSessionUserId', 'broadcastExpiresAt'])
  for (const update of s.updates) for (const key of Object.keys(update)) assert.ok(allowed.has(key), key)
  assert.equal(s.room().version, 7)
  assert.equal(s.room().gameId, 'game')
})

test('transfer validates authority and version; old lease drains before replacement', async () => {
  const s = server()
  const transfer = { userId: 'guest', broadcastVersion: 0 }
  await assert.rejects(s.call('guest', 'transferBroadcast', transfer), { code: 'FORBIDDEN' })
  await assert.rejects(s.call('owner', 'transferBroadcast', { ...transfer, userId: 'bot' }), { code: 'BAD_TARGET' })
  await assert.rejects(s.call('owner', 'transferBroadcast', { ...transfer, userId: 'missing' }), { code: 'BAD_TARGET' })
  await s.call('owner', 'heartbeatBroadcast', { sessionId: 'owner_device_00001' })
  await s.call('owner', 'transferBroadcast', transfer)
  assert.equal(s.context.broadcastView(s.room()).userId, 'guest')
  assert.equal((await s.call('owner', 'heartbeatBroadcast', { sessionId: 'owner_device_00001' })).granted, false)
  assert.equal((await s.call('guest', 'heartbeatBroadcast', { sessionId: 'guest_device_00001' })).granted, false)
  await assert.rejects(s.call('owner', 'transferBroadcast', transfer), { code: 'STALE_STATE' })
  s.advance(10001)
  assert.equal((await s.call('guest', 'heartbeatBroadcast', { sessionId: 'guest_device_00001' })).granted, true)
  assert.equal(s.room().version, 7)
  const view = s.context.project(s.room(), null, 'guest')
  assert.equal(JSON.stringify(view).includes('guest_device'), false)
  s.room().members = s.room().members.filter(item => item.userId !== 'guest')
  assert.equal(s.context.broadcastView(s.room()).userId, 'owner')
})

test('all night cues advance without a broadcaster or audio callbacks', () => {
  const s = server()
  const roles = ['狼人', '预言家', '女巫', '守卫', '村民']
  const room = { config: { total: 12, interval: 1 }, members: roles.map((role, i) => ({ userId: String(i), seat: i + 1, isBot: true })) }
  const game = { phase: 'NIGHT', day: 1, night: {}, roles: Object.fromEntries(roles.map((role, i) => [String(i), { role, alive: true, abilities: { antidote: false, poison: false } }])), actions: {}, confirmedUserIds: [] }
  s.context.setNightStage(game, room, 'WEREWOLF')
  const cues = []
  for (let i = 0; i < 30 && game.phase === 'NIGHT'; i++) {
    cues.push(`${game.nightStage}:${game.night.cue}`)
    const before = JSON.stringify(game)
    s.context.runBots(game, room)
    assert.equal(JSON.stringify(game), before)
    s.advance(game.stageReadyAt - s.context.Date.now())
    s.context.runBots(game, room)
  }
  assert.deepEqual(cues, ['WEREWOLF:START', 'WEREWOLF:OPEN', 'WEREWOLF:ACTION', 'WEREWOLF:CLOSE', 'SEER:OPEN', 'SEER:ACTION', 'SEER:CLOSE', 'WITCH:OPEN', 'WITCH:ACTION', 'WITCH:CLOSE', 'GUARD:OPEN', 'GUARD:ACTION', 'GUARD:CLOSE'])
  assert.equal(game.phase, 'DAWN')
})

test('leaving permanently returns broadcast to owner and preserves the newest lease deadline', async () => {
  const s = server()
  await s.call('owner', 'transferBroadcast', { userId: 'guest', broadcastVersion: 0 })
  const staleRoom = clone(s.room())
  await s.call('guest', 'heartbeatBroadcast', { sessionId: 'guest_device_00001' })
  const saved = await s.context.saveRoom(staleRoom, { members: staleRoom.members.filter(item => item.userId !== 'guest') })
  assert.equal(saved.broadcasterUserId, 'owner')
  assert.equal(saved.broadcastVersion, 2)
  assert.equal(saved.broadcastAvailableAt, 11000)
  // Rejoining must not restore the former broadcast assignment.
  saved.members.push({ userId: 'guest', nickname: '玩家', isBot: false })
  const rejoined = await s.context.saveRoom(saved, { members: saved.members })
  assert.equal(s.context.broadcastView(rejoined).userId, 'owner')
  assert.equal(s.signals.guest.roomId, 'room')
  assert.equal(s.signals.owner._openid, 'openid:owner')
  assert.deepEqual(Object.keys(s.signals.owner).sort(), ['_openid', 'broadcastVersion', 'roomId', 'version'])
  const publicRoom = s.context.project(rejoined, null, 'owner')
  assert.equal(publicRoom.members.some(item => item.openid), false)
})

test('reconnection restores persisted role and submitted result without exposing others', async () => {
  const s = server()
  const room = s.room()
  room.config = { total: 6, interval: 1 }
  room.members.forEach((item, i) => { item.seat = i + 1; item.isBot = false })
  const game = { _id: 'game', phase: 'NIGHT', nightStage: 'SEER', stageReadyAt: 0,
    day: 1, version: 7, night: { cue: 'ACTION', attackedSeat: 3 },
    roles: { owner: { role: '预言家', alive: true, abilities: {} }, guest: { role: '狼人', alive: true, abilities: {} }, bot: { role: '女巫', alive: true, abilities: { antidote: true, poison: true } } },
    actions: { '1:NIGHT:SEER:owner': { targetSeat: 2, result: '狼人阵营' } }, confirmedUserIds: [], publicResult: [], firstNightRevealed: false,
  }
  s.context.getRoomByUser = async () => clone(room)
  s.context.getGame = async () => clone(game)
  s.context.getUser = async () => ({ _id: 'owner', currentRoomId: 'room' })
  const before = JSON.stringify(game)
  const restored = await s.context.viewFor({ _id: 'owner', currentRoomId: 'room' })
  assert.equal(restored.game.myRole.role, '预言家')
  assert.equal(restored.game.myAction.submitted, true)
  assert.equal(restored.game.myAction.result, '狼人阵营')
  const waiting = await s.context.viewFor({ _id: 'guest', currentRoomId: 'room' })
  assert.equal(waiting.game.myAction, undefined)
  assert.equal(waiting.game.roles, undefined)
  assert.equal(waiting.game.actions, undefined)
  assert.equal(waiting.game.night, undefined)
  // Retrying after a lost response must preserve the originally submitted result.
  const retry = await s.context.dispatch('submitNightAction', { version: 7, targetSeat: 3 }, 'owner-openid')
  assert.equal(retry.game.myAction.result, '狼人阵营')
  assert.equal(JSON.stringify(game), before)
  assert.equal(s.updates.length, 0)
})

function client() {
  let now = 1000
  let heartbeat = async () => ({ granted: true, leaseMs: 10000, version: 0 })
  const played = [], timers = new Map()
  let timerId = 0, stopped = 0
  const context = { exports: {}, Date: { now: () => now }, Math,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, due: now + ms }); return timerId }, clearTimeout: id => timers.delete(id),
    require: name => name === '../api/client' ? { api: { heartbeatBroadcast: () => heartbeat(), releaseBroadcast: async () => {} } } : { playAnnouncement: name => played.push(name), stopAnnouncement: () => { stopped++ } },
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/broadcast.js'), 'utf8'), context)
  return { api: context.exports, played, stopped: () => stopped, heartbeat: fn => { heartbeat = fn }, advance: ms => { now += ms; for (const [id, timer] of timers) if (timer.due <= now) { timers.delete(id); timer.fn() } } }
}
const broadcastRoom = { broadcast: { userId: 'owner', version: 0 } }

test('only selected player sounds; repeat polls do not repeat, replay is explicit', async () => {
  const c = client()
  c.api.startBroadcast()
  await c.api.syncBroadcast(broadcastRoom, 'guest', 'night', 'start')
  assert.deepEqual(c.played, [])
  await c.api.syncBroadcast(broadcastRoom, 'owner', 'night', 'start')
  await c.api.syncBroadcast(broadcastRoom, 'owner', 'night', 'start')
  assert.deepEqual(c.played, ['night'])
  await c.api.syncBroadcast(broadcastRoom, 'owner', 'night', 'start', true)
  assert.deepEqual(c.played, ['night', 'night'])
  const stops = c.stopped()
  c.advance(9500)
  assert.ok(c.stopped() > stops)
})

test('background, stale responses and slow network cannot restart unauthorized audio', async () => {
  const c = client()
  c.api.startBroadcast()
  let resolve
  c.heartbeat(() => new Promise(done => { resolve = done }))
  const pending = c.api.syncBroadcast(broadcastRoom, 'owner', 'night', 'start')
  c.api.stopBroadcast()
  resolve({ granted: true, leaseMs: 10000, version: 0 })
  await pending
  assert.deepEqual(c.played, [])
  c.api.startBroadcast()
  const stale = c.api.syncBroadcast(broadcastRoom, 'owner', 'night', 'start')
  await c.api.syncBroadcast({ broadcast: { userId: 'guest', version: 1 } }, 'owner', 'seer', 'next')
  resolve({ granted: true, leaseMs: 10000, version: 0 })
  await stale
  assert.deepEqual(c.played, [])
  c.heartbeat(async () => { c.advance(11000); return { granted: true, leaseMs: 10000, version: 0 } })
  await c.api.syncBroadcast(broadcastRoom, 'owner', 'night', 'start')
  assert.deepEqual(c.played, [])
})

test('heartbeat failure expires local audio while public text can keep updating', async () => {
  const c = client()
  c.api.startBroadcast()
  await c.api.syncBroadcast(broadcastRoom, 'owner', 'night', 'start')
  c.advance(6000)
  c.heartbeat(async () => { throw new Error('offline') })
  assert.equal(await c.api.syncBroadcast(broadcastRoom, 'owner', 'seer-open', 'next'), true)
  assert.deepEqual(c.played, ['night', 'seer-open'])
  const stops = c.stopped()
  c.advance(9500)
  assert.ok(c.stopped() > stops)
})

test('game page ignores late responses after hiding and reloads database facts on return', async () => {
  let page, resolve, intervals = 0, announced = 0
  const session = { profile: { id: 'owner' }, room: { id: 'room', ownerId: 'owner', members: [{ userId: 'owner', seat: 1, nickname: '房主' }], broadcast: { userId: 'owner', version: 0 },
    game: { id: 'game', day: 1, phase: 'NIGHT', nightStage: 'SEER', nightCue: 'ACTION', publicResult: [], myAction: { type: 'SEER', submitted: true, result: '狼人阵营' } } } }
  const context = { exports: {}, Date, Promise, wx: { redirectTo() {}, reLaunch() {} },
    Page: value => { page = value; page.setData = data => Object.assign(page.data, data) },
    setInterval: () => ++intervals, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('api/client') ? { api: { session: () => new Promise(done => { resolve = done }) }, showError: () => {} } : name.includes('services/announcements') ? require(path.join(build, 'miniprogram/services/announcements.js')) : name.includes('services/broadcast') ? { startBroadcast() {}, stopBroadcast() {}, syncBroadcast: async () => { announced++; return true }, chooseBroadcaster: async () => {} } : name.includes('services/room-controller') ? { watchRoom: () => () => {}, serverOffset: () => 0 } : {},
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/game/game.js'), 'utf8'), context)
  const pending = page.onShow()
  page.onHide()
  resolve(clone(session))
  await pending
  assert.equal(page.data.room, null)
  assert.equal(intervals, 0)
  assert.equal(announced, 0)
  const resumed = page.onShow()
  resolve(clone(session))
  await resumed
  assert.equal(page.data.action.submitted, true)
  assert.equal(page.data.action.result, '狼人阵营')
  assert.equal(page.data.announcementText, '预言家请行动')
  assert.equal(intervals, 2)
  assert.equal(announced, 1)
})

test('command acknowledgement leaves state to subscription without a second query; old snapshots are ignored', async () => {
  let page, queries = 0
  const initial = { id: 'room', version: 1, ownerId: 'owner', members: [], broadcast: { userId: 'owner', version: 0 }, game: { id: 'game', phase: 'DAWN', day: 1, publicResult: [], myConfirmed: false } }
  const updated = { ...initial, version: 2, game: { ...initial.game, myConfirmed: true } }
  const context = { exports: {}, Date, wx: { redirectTo() {}, reLaunch() {} }, setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
    Page: value => { page = value; page.setData = data => Object.assign(page.data, data) },
    require: name => name.includes('services/page-data') ? require(path.join(build, 'miniprogram/services/page-data.js')) : name.includes('api/client') ? { api: { confirmDawn: async () => ({ accepted: true, version: 2 }), session: async () => { queries++; return {} } }, showError: error => { throw error } } : name.includes('services/announcements') ? require(path.join(build, 'miniprogram/services/announcements.js')) : name.includes('services/broadcast') ? { syncBroadcast: async () => true } : {},
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/game/game.js'), 'utf8'), context)
  page.visible = true
  page.data.myId = 'owner'
  page.data.room = clone(initial)
  await page.confirmDawn()
  assert.equal(page.data.room.version, 1)
  page.applyRoom(clone(updated))
  assert.equal(page.data.dawnConfirmed, true)
  assert.equal(page.data.room.version, 2)
  assert.equal(queries, 0)
  page.applyRoom(clone(initial))
  assert.equal(page.data.dawnConfirmed, true)
  assert.equal(page.data.room.version, 2)
})

test('valid broadcast lease plays the next cue without waiting for another heartbeat', async () => {
  const c = client()
  c.api.startBroadcast()
  await c.api.syncBroadcast(broadcastRoom, 'owner', 'night', 'start')
  let heartbeats = 0
  c.heartbeat(async () => { heartbeats++; throw new Error('must not wait') })
  await c.api.syncBroadcast(broadcastRoom, 'owner', 'werewolf-open', 'open')
  assert.deepEqual(c.played, ['night', 'werewolf-open'])
  assert.equal(heartbeats, 0)
})

test('caller-owned realtime signal deduplicates snapshots, reconnects and closes on hide', async () => {
  let callbacks, refreshed = 0, closed = 0, retried
  const statuses = []
  const current = { id: 'room', version: 2, broadcast: { version: 0 } }
  const context = { exports: {},
    setTimeout: fn => { retried = fn; return 1 }, clearTimeout() {},
    require: name => name.includes('virtual-users') ? { identityGeneration: () => 0 } : ({ api: { syncIdentity: async () => ({ userId: 'owner', openid: 'openid:owner' }) } }),
    wx: { cloud: { database: () => ({ collection: name => { assert.equal(name, 'room_signals'); return { where: query => { assert.equal(query._openid, 'openid:owner'); return { watch: options => { callbacks = options; return { close: async () => { closed++ } } } } } } } }) } },
  }
  const businessRequire = context.require
  context.require = name => name.endsWith('/backend') ? cloudBackend(build, context.wx) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/room-sync.js'), 'utf8'), context)
  const stop = context.exports.watchRoom(() => refreshed++, value => statuses.push(value), () => current)
  await new Promise(resolve => setImmediate(resolve))
  callbacks.onChange({ docs: [{ _id: 'owner', roomId: 'room', version: 2, broadcastVersion: 0 }] })
  assert.equal(refreshed, 0)
  callbacks.onChange({ docs: [{ _id: 'owner', roomId: 'room', version: 3, broadcastVersion: 0 }] })
  callbacks.onChange({ docs: [{ _id: 'owner', roomId: 'room', version: 3, broadcastVersion: 0 }] })
  assert.equal(refreshed, 1)
  callbacks.onError()
  assert.equal(statuses.at(-1), false)
  retried()
  await new Promise(resolve => setImmediate(resolve))
  stop()
  const count = refreshed
  callbacks.onChange({ docs: [{ _id: 'owner', roomId: 'room', version: 4, broadcastVersion: 0 }] })
  assert.equal(refreshed, count)
  assert.equal(closed, 2)
})

test('timing follows bundled audio duration and configured interval instead of a fixed 3s padding', () => {
  const s = server()
  const game = { nightStage: 'SEER', night: {}, roles: { seer: { role: '预言家', alive: true } } }
  s.context.setNightCue(game, { config: { interval: 3 } }, 'OPEN')
  assert.equal(game.stageReadyAt - s.context.Date.now(), 4600)
  s.context.setNightCue(game, { config: { interval: 3 } }, 'ACTION')
  assert.equal(game.stageReadyAt - s.context.Date.now(), 3000)
  s.context.setNightCue(game, { config: { interval: 1 } }, 'ACTION')
  assert.equal(game.stageReadyAt - s.context.Date.now(), 1850)
})

test('recommendations for every supported size generate an exact, valid deck; classic boards remain compatible', () => {
  const frontend = require(path.join(build, 'miniprogram/domain/room-config.js'))
  const backend = require('../cloudfunctions/api/room-config')
  for (const total of frontend.roomSizes) {
    const config = { ...frontend.recommendBoard(total), winMode: '屠边', interval: 3 }
    const deck = backend.buildRoles(config)
    assert.equal(deck.length, total)
    assert.equal(deck.filter(role => role === '狼人').length, config.wolves)
    assert.equal(deck.filter(role => role === '村民').length, config.villagers)
    for (const god of frontend.godRoles) assert.ok(deck.filter(role => role === god).length <= 1)
  }
  assert.deepEqual(backend.buildRoles({ total: 6, wolves: 2, gods: 2, villagers: 2, winMode: '屠边', interval: 3 }), ['狼人', '狼人', '预言家', '女巫', '村民', '村民'])
})

test('custom board is independently validated by backend, including password and totals', () => {
  const { normalizeConfig, buildRoles } = require('../cloudfunctions/api/room-config')
  const board = { total: 8, wolves: 2, gods: 1, villagers: 5, godRoles: ['守卫'], winMode: '屠城', interval: 2, password: 'friends' }
  assert.equal(buildRoles(board).length, 8)
  assert.equal(normalizeConfig(board).password, undefined)
  for (const invalid of [
    { total: 5 }, { total: 17 }, { wolves: 4, villagers: 3 }, { wolves: 0, villagers: 7 },
    { gods: 2 }, { villagers: 4 }, { godRoles: [] }, { godRoles: ['预言家', '预言家'] },
    { godRoles: ['未知身份'] }, { interval: 0 }, { interval: 7 }, { winMode: '未知规则' }, { password: '123456789' },
  ]) assert.throws(() => normalizeConfig({ ...board, ...invalid }), { code: 'BAD_CONFIG' })
})

test('custom guard stage runs at 8 players, while omitted seer and witch stages are skipped', () => {
  const s = server()
  const roles = require('../cloudfunctions/api/room-config').buildRoles({ total: 8, wolves: 2, gods: 1, villagers: 5, godRoles: ['守卫'], winMode: '屠边', interval: 1 })
  const room = { config: { total: 8, interval: 1 }, members: roles.map((role, i) => ({ userId: String(i), seat: i + 1, isBot: true })) }
  const game = { phase: 'NIGHT', day: 1, night: {}, roles: Object.fromEntries(roles.map((role, i) => [String(i), { role, alive: true, abilities: {} }])), actions: {}, confirmedUserIds: [] }
  s.context.setNightStage(game, room, 'WEREWOLF')
  const cues = []
  for (let i = 0; i < 20 && game.phase === 'NIGHT'; i++) {
    cues.push(`${game.nightStage}:${game.night.cue}`)
    s.advance(game.stageReadyAt - s.context.Date.now())
    s.context.runBots(game, room)
  }
  assert.deepEqual(cues, ['WEREWOLF:START', 'WEREWOLF:OPEN', 'WEREWOLF:ACTION', 'WEREWOLF:CLOSE', 'GUARD:OPEN', 'GUARD:ACTION', 'GUARD:CLOSE'])
  assert.equal(game.phase, 'DAWN')
})

test('room deletion invalidates every human member without broadcasting identities or roles', async () => {
  const s = server()
  await s.context.clearRoomSignals(s.room())
  assert.equal(s.signals.owner.roomId, '')
  assert.equal(s.signals.guest.roomId, '')
  assert.equal(s.signals.bot, undefined)
  assert.equal(s.updates.length, 0)
})

test('shared room controller coalesces events, polls slowly when connected, and stops on hide', async () => {
  let now = 1000, interval, signal, connected, finish, requests = 0, closed = 0
  const context = { exports: {}, Date: { now: () => now }, Math: { ...Math, random: () => .5, round: Math.round, min: Math.min, pow: Math.pow },
    setInterval: fn => { interval = fn; return 1 }, clearInterval() {},
    require: name => name.includes('virtual-users') ? { identityGeneration: () => 0 } : { watchRoom: (refresh, status) => { signal = refresh; connected = status; return () => { closed++ } } },
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/room-controller.js'), 'utf8'), context)
  const stop = context.exports.watchRoom(() => { requests++; return new Promise(resolve => { finish = resolve }) }, () => {}, () => null)
  connected(true)
  now += 9000; interval(); assert.equal(requests, 0)
  now += 1000; interval(); assert.equal(requests, 1)
  signal(); signal(); signal(); assert.equal(requests, 1)
  finish(true); await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, 2)
  finish(true); await new Promise(resolve => setImmediate(resolve))
  now += 9000; interval(); assert.equal(requests, 2)
  now += 1000; interval(); assert.equal(requests, 3)
  stop(); finish(true); await Promise.resolve(); signal(); now += 30000; interval()
  assert.equal(requests, 3)
  assert.equal(closed, 1)
})

test('shared room controller backs off repeated failed snapshots and recovers after success', async () => {
  let now = 0, interval, requests = 0, fail = true
  const context = { exports: {}, Date: { now: () => now }, Math: { random: () => .5, round: Math.round, min: Math.min, pow: Math.pow },
    setInterval: fn => { interval = fn; return 1 }, clearInterval() {},
    require: name => name.includes('virtual-users') ? { identityGeneration: () => 0 } : { watchRoom: () => () => {} },
  }
  const businessRequire = context.require
  context.require = name => name.includes('domain/vote-sections') ? require(path.join(build, 'miniprogram/domain/vote-sections.js')) : name.includes('telemetry') ? require(path.join(build, 'miniprogram/services/telemetry.js')) : businessRequire(name)
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/services/room-controller.js'), 'utf8'), context)
  const stop = context.exports.watchRoom(async () => { requests++; return !fail }, () => {}, () => null)
  const poll = async time => { now = time; interval(); await Promise.resolve(); await Promise.resolve() }
  await poll(2000); await poll(4000); assert.equal(requests, 2)
  await poll(6000); assert.equal(requests, 2)
  await poll(8000); assert.equal(requests, 3)
  fail = false; await poll(16000); assert.equal(requests, 4)
  await poll(18000); assert.equal(requests, 5)
  stop()
})

test('clock-only snapshots do not send room data, while private results and lease changes do', () => {
  const { setChangedData } = require(path.join(build, 'miniprogram/services/page-data.js'))
  const calls = [], room = { id: 'r', version: 1, broadcast: { online: true }, game: { serverTime: 1000, myRole: { role: '预言家' } } }
  const page = { data: { room, countdown: 10 }, setData: patch => { calls.push(patch); Object.assign(page.data, patch) } }
  setChangedData(page, { room: { ...room, game: { ...room.game, serverTime: 2000 } }, countdown: 10 })
  assert.equal(calls.length, 0)
  setChangedData(page, { room: { ...room, game: { ...room.game, serverTime: 2000, myAction: { result: '狼人阵营' } } } })
  assert.equal(calls.length, 1)
  setChangedData(page, { room: { ...page.data.room, broadcast: { online: false } } })
  assert.equal(calls.length, 2)
})

test('new role controls confirm irreversible choices and submit the selected target with current version', async () => {
  let page, toast
  const calls = []
  const api = Object.fromEntries(['shoot', 'knightDuel', 'wolfExplode', 'submitNightAction'].map(action => [action, async (...args) => { calls.push({ action, args }) }]))
  const context = { exports: {}, Page: value => { page = value }, require: name => name.includes('/api/client') ? { api, showError: error => { throw error } } : {}, wx: { showToast: value => { toast = value.title }, showModal: value => { value.success({ confirm: true }) } } }
  vm.runInNewContext(fs.readFileSync(path.join(build, 'miniprogram/pages/game/game.js'), 'utf8'), context)
  page.setData = value => Object.assign(page.data, value)
  page.data.room = { version: 9, game: { myRole: { role: '白狼王' } } }
  page.wolfExplode(); assert.equal(toast, '请选择自爆带走的目标'); assert.equal(calls.length, 0)
  page.data.selectedDaySeat = 3; page.wolfExplode(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0].action, 'wolfExplode'); assert.deepEqual(Array.from(calls[0].args), [9, 3])
  page.data.selectedDaySeat = 4; await page.shoot({ currentTarget: { dataset: {} } }); await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[1].action, 'shoot'); assert.deepEqual(Array.from(calls[1].args), [4, 9])
  await page.shoot({ currentTarget: { dataset: { skip: true } } }); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(Array.from(calls[2].args), [0, 9])
  page.data.selectedDaySeat = 5; page.knightDuel(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[3].action, 'knightDuel'); assert.deepEqual(Array.from(calls[3].args), [5, 9])
  page.data.action = { type: 'GRAVEKEEPER', result: '3号：狼人阵营' }
  await page.submitAction(); assert.equal(calls[4].action, 'submitNightAction'); assert.equal(calls[4].args[0].confirmResult, true); assert.equal(calls[4].args[0].targetSeat, undefined)
})

test('special wolf selection respects available wolf slots and travels in the create request', async () => {
  let page, created, toast
  const context = { exports: {}, Page: value => { page = value }, require: name => name.includes('/api/client') ? { api: { createRoom: async value => { created = value } }, showError: error => { throw error } } : name.includes('domain/room-config') ? require(path.join(build, 'miniprogram/domain/room-config.js')) : {}, wx: { showToast: value => { toast = value.title }, showLoading() {}, hideLoading() {}, redirectTo() {} } }
  vm.runInNewContext(fs.readFileSync(path.join(build, 'miniprogram/pages/create/create.js'), 'utf8'), context)
  page.setData = value => Object.assign(page.data, value)
  page.toggleWolf({ currentTarget: { dataset: { role: '白狼王' } } })
  page.toggleWolf({ currentTarget: { dataset: { role: '狼王' } } })
  assert.equal(page.data.wolfRoles.length, 2)
  page.applyBoard(6, 1, ['预言家', '女巫']); assert.equal(page.data.wolfRoles.length, 1)
  page.toggleWolf({ currentTarget: { dataset: { role: '狼王' } } }); assert.equal(page.data.wolfRoles.length, 1); assert.equal(toast, '特殊狼人不能超过狼人名额')
  await page.submit(); assert.deepEqual(Array.from(created.wolfRoles), ['白狼王']); assert.equal(created.wolves + created.gods + created.villagers, created.total)
})

test('room rules use only configured roles and account for replacements without exposing player identities', () => {
  const { rulesForRoom } = require(path.join(build, 'miniprogram/domain/room-rules.js'))
  const rules = rulesForRoom({ total: 12, wolves: 4, gods: 4, villagers: 4, godRoles: ['女巫', '守卫', '守墓人', '骑士'], wolfRoles: ['白狼王', '狼王'], wildChild: true, winMode: '屠边', interval: 2 })
  const rows = rules.groups.flatMap(group => group.roles)
  assert.equal(rows.reduce((count, role) => count + role.count, 0), 12)
  assert.equal(rows.find(role => role.role === '狼人').count, 2)
  assert.equal(rows.find(role => role.role === '村民').count, 3)
  assert.equal(rows.find(role => role.role === '野孩子').count, 1)
  assert.equal(rows.some(role => role.role === '猎人' || role.role === '白痴'), false)
  assert.match(rows.find(role => role.role === '女巫').description, /每晚最多使用一种/)
  assert.match(rows.find(role => role.role === '骑士').description, /被决斗的狼王不能开枪/)
  assert.match(rules.winRule, /达到或超过存活好人数/)
  assert.match(rules.winRule, /神职或平民任一类全部出局/)
  assert.equal(JSON.stringify(rules).includes('userId'), false)
  const classic = rulesForRoom({ total: 9, wolves: 3, gods: 3, villagers: 3, winMode: '屠城', interval: 3 })
  assert.deepEqual(classic.groups[1].roles.map(role => role.role), ['预言家', '女巫', '猎人'])
  assert.equal(classic.groups.flatMap(group => group.roles).some(role => role.role === '野孩子'), false)
})

test('rules sheet is exclusive with identity and voting sheets and closes when the page hides', () => {
  let page
  const context = { exports: {}, Page: value => { page = value }, clearInterval() {}, clearTimeout() {}, require: name => name.includes('domain/room-rules') ? require(path.join(build, 'miniprogram/domain/room-rules.js')) : name.includes('services/broadcast') ? { stopBroadcast() {} } : {} }
  vm.runInNewContext(fs.readFileSync(path.join(build, 'miniprogram/pages/game/game.js'), 'utf8'), context)
  page.setData = value => Object.assign(page.data, value)
  page.data.room = { config: { total: 6, wolves: 2, gods: 2, villagers: 2, godRoles: ['预言家', '女巫'], winMode: '屠边', interval: 3 }, game: { myRole: { role: '狼人' } } }
  page.data.identityOpen = true; page.data.voteSheetOpen = true
  page.openRules(); assert.equal(page.data.rulesOpen, true); assert.equal(page.data.identityOpen, false); assert.equal(page.data.voteSheetOpen, false)
  assert.equal(page.data.roomRules.settings[0].value, '6 人')
  page.openVotes(); assert.equal(page.data.rulesOpen, false)
  page.openRules(); page.openIdentity(); assert.equal(page.data.rulesOpen, false)
  page.openRules(); page.visible = true; page.onHide(); assert.equal(page.data.rulesOpen, false)
})

test('remaining guesses deduct only explicit roles and count gods within good players', () => {
  const { remainingGuesses } = require(path.join(build, 'miniprogram/domain/notes.js'))
  const room = { config: { total: 12, wolves: 4, gods: 4, villagers: 4 } }
  const rows = ['偏狼', '偏好', '未知', '狼王', '预言家', '村民', '野孩子'].map(roleGuess => ({ roleGuess }))
  assert.deepEqual(remainingGuesses(room, rows), { wolves: 3, gods: 3, good: 5, excess: false })
  assert.deepEqual(remainingGuesses(room, Array.from({ length: 5 }, () => ({ roleGuess: '狼人' }))), { wolves: 0, gods: 4, good: 8, excess: true })
})

test('relations preserve direction, replace one pair, reject self edges and malformed drafts', () => {
  const { setRelation, validRelations, seatPositions } = require(path.join(build, 'miniprogram/domain/relations.js'))
  const first = setRelation([], { source: 1, target: 2, type: 'ATTACK' })
  assert.equal(setRelation(first, first[0]), first)
  assert.equal(setRelation(first, { source: 1, target: 1, type: 'SUPPORT' }), first)
  const second = setRelation(first, { source: 2, target: 1, type: 'SUPPORT' })
  assert.equal(second.length, 2)
  const replaced = setRelation(second, { source: 1, target: 2, type: 'SUPPORT' })
  assert.equal(replaced.length, 2); assert.equal(first[0].type, 'ATTACK')
  assert.equal(validRelations(replaced, [1, 2]), true)
  for (const bad of [[...first, ...first], [{ source: 1, target: 3, type: 'ATTACK' }], [{ source: 1, target: 1, type: 'SUPPORT' }], [{ source: 1, target: 2, type: 'unknown' }]]) assert.equal(validRelations(bad, [1, 2]), false)
  const positions = seatPositions(Array.from({ length: 16 }, (_, i) => i + 1))
  assert.equal(positions.length, 16); assert.ok(positions.every(node => node.x >= 10 && node.x <= 90 && node.y >= 10 && node.y <= 90))
})

test('backend relation records sanitize fields and reject invalid or duplicate directed edges', () => {
  const { normalizeNote, noteView } = require('../cloudfunctions/api/note-format')
  const members = [{ seat: 1 }, { seat: 2 }], edge = { source: 1, target: 2, type: 'ATTACK', role: '狼人' }
  const note = normalizeNote({ kind: 'relations', targetSeat: -1, edges: [edge], ownerId: 'other', day: 9 }, members)
  assert.deepEqual(note.edges, [{ source: 1, target: 2, type: 'ATTACK' }])
  assert.equal(note.ownerId, undefined); assert.equal(note.day, undefined)
  assert.deepEqual(noteView({ ...note, revision: 3 }).edges, note.edges)
  for (const edges of [null, [edge, edge], [{ ...edge, source: 0 }], [{ ...edge, target: 1 }], [{ ...edge, type: 'CUSTOM' }], Array(241).fill(edge)]) assert.throws(() => normalizeNote({ kind: 'relations', targetSeat: -1, edges }, members), { code: 'BAD_NOTES' })
  assert.throws(() => normalizeNote({ kind: 'relations', targetSeat: 1, edges: [] }, members), { code: 'BAD_NOTES' })
})

test('relation page saves newer edits after an in-flight request and restores undo/redo', async () => {
  let page, finish, offline = false
  const storage = {}, sent = []
  const context = { exports: {}, Promise, setTimeout: () => 1, clearTimeout() {}, wx: { setStorageSync: (key, value) => { storage[key] = clone(value) }, removeStorageSync: key => { delete storage[key] } },
    Page: value => { page = value }, require: name => name.includes('api/client') ? { ApiError: Error, api: { saveNote: note => { sent.push(clone(note)); return offline ? Promise.reject(new Error('offline')) : new Promise(resolve => { finish = () => resolve({ ...note, revision: note.revision + 1 }) }) } } } : name.includes('domain/relations') ? require(path.join(build, 'miniprogram/domain/relations.js')) : {} }
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(build, 'miniprogram/pages/relations/relations.js'), 'utf8'), context)
  page.setData = patch => Object.assign(page.data, patch); page.draw = () => {}; page.data.loading = false; page.gameId = 'g'; page.draftKey = 'private:g'
  page.commit([{ source: 1, target: 2, type: 'ATTACK' }]); const saving = page.saveAll(); await Promise.resolve()
  page.commit([{ source: 1, target: 2, type: 'SUPPORT' }]); finish(); await saving
  assert.equal(page.dirty, true); assert.equal(storage['private:g'].revision, 1); assert.equal(storage['private:g'].edges[0].type, 'SUPPORT')
  const next = page.saveAll(); await Promise.resolve(); finish(); await next
  assert.equal(sent[1].revision, 1); assert.equal(page.dirty, false); assert.equal(storage['private:g'], undefined)
  page.undo(); assert.equal(page.data.edges[0].type, 'ATTACK'); page.redo(); assert.equal(page.data.edges[0].type, 'SUPPORT')
  offline = true; await page.saveAll(); assert.equal(page.dirty, true); assert.equal(storage['private:g'].edges[0].type, 'SUPPORT')
})

test('vote sections show current latest round separately and order preceding results newest first', () => {
  const { voteSections } = require(path.join(build, 'miniprogram/domain/vote-sections.js'))
  const sheriff = { day: 1, kind: 'SHERIFF', round: 1 }, first = { day: 2, kind: 'EXILE', round: 1 }, second = { day: 2, kind: 'EXILE', round: 2 }
  const game = { phase: 'DAY', day: 2, dayView: { stage: 'COMPLETE' }, voteHistory: [sheriff, first, second] }
  const sections = voteSections(game)
  assert.equal(sections.currentVote, second); assert.deepEqual(sections.previousVotes, [first, sheriff]); assert.deepEqual(game.voteHistory, [sheriff, first, second])
  game.dayView.stage = 'EXILE_PK_SPEECH'; game.voteHistory = [sheriff, first]
  assert.equal(voteSections(game).currentVote, first)
  game.dayView.stage = 'SPEECH'
  assert.equal(voteSections(game).currentVote, null)
  game.day = 3; game.dayView.stage = 'EXILE_VOTE'
  assert.equal(voteSections(game).currentVote, null)
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/game/game.wxml'), 'utf8')
  assert.ok(template.indexOf('bindtap="exileVote"') < template.indexOf('class="card day-flow current-vote"'))
  assert.ok(template.indexOf('bindtap="nextNight"') < template.indexOf('class="card stage-history"'))
  assert.ok(template.indexOf('bindtap="shoot"') < template.indexOf('class="card stage-history"'))
})

test('multiple identity guesses survive saving and legacy notes remain readable', () => {
  const { normalizeNote, noteView } = require('../cloudfunctions/api/note-format')
  const { noteRows, rowNote } = require(path.join(build, 'miniprogram/domain/notes.js'))
  const room = { members: [{ seat: 1, nickname: '玩家' }] }
  const saved = noteView(normalizeNote({ targetSeat: 1, roleGuesses: ['预言家', '女巫', '预言家', '未知', '非法身份'] }, room.members))
  assert.deepEqual(saved.roleGuesses, ['预言家', '女巫'])
  const row = noteRows(room, [saved])[0]
  assert.equal(row.roleGuess, '预言家 / 女巫'); assert.deepEqual(rowNote(row).roleGuesses, ['预言家', '女巫'])
  assert.deepEqual(noteRows(room, [{ targetSeat: 1, roleGuess: '狼王', tags: [], text: '' }])[0].roleGuesses, ['狼王'])
  assert.deepEqual(noteView(normalizeNote({ targetSeat: 1, roleGuess: '狼人', roleGuesses: [] }, room.members)).roleGuesses, [])
})

test('skill role guesses deduct once across players while ordinary wolves and villagers deduct per player', () => {
  const { remainingGuesses } = require(path.join(build, 'miniprogram/domain/notes.js'))
  const room = { config: { total: 16, wolves: 4, gods: 6 } }
  const rows = [
    { roleGuesses: ['预言家', '女巫', '狼王', '野孩子', '偏狼'] },
    { roleGuesses: ['预言家', '狼王', '野孩子', '偏好'] },
    { roleGuesses: ['狼人', '村民'] }, { roleGuesses: ['狼人', '村民'] },
  ]
  assert.deepEqual(remainingGuesses(room, rows), { wolves: 1, gods: 4, good: 7, excess: false })
  assert.deepEqual(remainingGuesses(room, [{ roleGuesses: ['预言家'] }, { roleGuesses: ['预言家'] }]), { wolves: 4, gods: 5, good: 11, excess: false })
})
