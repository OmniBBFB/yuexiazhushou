const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { database } = require('./helpers/database')
const apiRoot = path.resolve(__dirname, '../cloudfunctions/api')
const { buildRoles, normalizeConfig } = require('../cloudfunctions/api/room-config')
const { isWolf, transformWildChildren } = require('../cloudfunctions/api/role-state')

function fixture() {
  const names = ['野孩子', '狼人', '预言家', '女巫', '村民', '守卫']
  const members = names.map((role, i) => ({ userId: String(i), openid: String(i), authOpenid: String(i), seat: i + 1, nickname: `玩家${i}`, alive: true, ready: true, roleConfirmed: true }))
  return {
    users: members.map(item => ({ _id: item.userId, openid: item.openid, authOpenid: item.openid, nickname: item.nickname, currentRoomId: 'r' })),
    rooms: [{ _id: 'r', ownerId: '1', code: '123456', version: 1, gameId: 'g', status: 'PLAYING', config: { total: 6, wolves: 1, gods: 3, godRoles: ['预言家', '女巫', '守卫'], villagers: 2, interval: 1, winMode: '屠边', wildChild: true }, members }],
    games: [{ _id: 'g', roomId: 'r', phase: 'NIGHT', day: 1, nightStage: 'WILD_CHILD', night: { cue: 'ACTION' }, actions: {}, stageReadyAt: 0, firstNightRevealed: false, confirmedUserIds: [], publicResult: [], roles: Object.fromEntries(names.map((role, i) => [String(i), { role, alive: true, abilities: {} }])) }],
  }
}
function server(seed = fixture()) {
  let clock = 1000
  const memory = database(seed)
  const context = { exports: {}, Date: class extends Date { static now() { return clock } }, console: { info() {}, error() {} },
    require: name => name === 'wx-server-sdk' ? { init() {}, database: () => memory.db, getWXContext: () => ({ OPENID: 'unused' }) } : name.startsWith('./') ? require(path.join(apiRoot, name)) : require(name) }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(apiRoot, 'index.js'), 'utf8'), context)
  context.project = vm.runInContext('project', context)
  return { ...memory, context, rules: vm.runInContext('rules', context),
    call: (action, payload = {}, user = '0') => context.dispatch(action, { version: memory.docs('rooms')[0].version, ...payload }, user),
    advance: ms => { clock += ms } }
}

test('wild child replaces one villager without changing deck size, gods or classic boards', () => {
  const config = fixture().rooms[0].config
  const deck = buildRoles(config)
  assert.equal(deck.length, 6)
  assert.equal(deck.filter(role => role === '野孩子').length, 1)
  assert.equal(deck.filter(role => role === '村民').length, 1)
  assert.equal(normalizeConfig(config).gods, 3)
  assert.equal(buildRoles({ ...config, wildChild: false }).filter(role => role === '村民').length, 2)
  assert.throws(() => normalizeConfig({ ...config, wildChild: 'yes' }), { code: 'BAD_CONFIG' })
})

test('model selection is private, excludes self, persists atomically and closes before wolves open', async () => {
  const s = server()
  await assert.rejects(s.call('submitNightAction', { targetSeat: 1 }), { code: 'BAD_TARGET' })
  await assert.rejects(s.call('submitNightAction', { targetSeat: 3 }, '1'), { code: 'FORBIDDEN' })
  s.failWrite(name => name === 'room_signals')
  await assert.rejects(s.call('submitNightAction', { targetSeat: 2 }), /injected write failure/)
  assert.equal(s.docs('games')[0].roles['0'].modelUserId, undefined)
  s.failWrite(null)
  await s.call('submitNightAction', { targetSeat: 2 })
  assert.equal(s.docs('games')[0].roles['0'].modelUserId, '1')
  assert.equal(s.docs('games')[0].night.cue, 'CLOSE')
  const mine = await s.call('getRoom')
  assert.equal(mine.game.myRole.modelSeat, 2)
  const other = await s.call('getRoom', {}, '2')
  assert.equal(other.game.myRole.modelSeat, undefined)
  assert.equal(JSON.stringify(other).includes('modelUserId'), false)
  const publicState = s.docs('room_states')[0].state
  assert.equal(publicState.config.wildChild, true)
  assert.equal(publicState.game.myRole, undefined)
  assert.equal(JSON.stringify(publicState).includes('modelUserId'), false)
  const privateState = s.docs('room_signals').find(item => item._id === '0').state
  assert.equal(privateState.game.myRole.modelSeat, 2)
  assert.equal(s.docs('room_signals').find(item => item._id === '2').state.game.myRole.modelSeat, undefined)
  s.advance(10000)
  await s.call('session')
  assert.equal(s.docs('games')[0].nightStage, 'WEREWOLF')
  assert.equal(s.docs('games')[0].night.cue, 'OPEN')
})

test('role reveal starts child first, with one start cue, and bots choose a persistent other-player model', () => {
  const s = server(), seed = fixture(), game = seed.games[0], room = seed.rooms[0]
  game.phase = 'ROLE_REVEAL'; game.confirmedUserIds = room.members.map(item => item.userId); game.nightStage = ''; game.night = {}
  s.rules.runBots(game, room)
  assert.equal(game.nightStage, 'WILD_CHILD')
  assert.equal(game.night.cue, 'START')
  room.members[0].isBot = true; game.night.cue = 'ACTION'; game.stageReadyAt = 0
  s.rules.runBots(game, room)
  assert.notEqual(game.roles['0'].modelUserId, '0')
  assert.ok(game.roles[game.roles['0'].modelUserId])
  assert.equal(game.night.cue, 'CLOSE')
})

test('night death converts before victory checks but never reveals conversion before next night', () => {
  const s = server(), seed = fixture(), room = seed.rooms[0], game = seed.games[0]
  game.roles['0'].modelUserId = '1'; game.night = { attackedSeat: 2 }
  s.rules.resolveNight(game, room)
  assert.equal(game.roles['1'].alive, false)
  assert.equal(isWolf(game.roles['0']), true)
  assert.notEqual(s.rules.winner(game, room), '好人阵营获胜')
  let view = s.context.project(room, game, '0')
  assert.equal(view.game.myRole.transformed, false)
  assert.equal(view.members.find(item => item.userId === '1').alive, true)
  assert.equal(view.game.confirmationRequired, true)
  game.phase = 'DAY'; game.dayState = { stage: 'SHERIFF_SIGNUP', signup: {}, candidates: [] }
  assert.equal(s.context.project(room, game, '0').game.dayView.canExplode, false)
  game.day = 2; game.phase = 'NIGHT'; game.nightStage = 'WEREWOLF'; game.night = { cue: 'ACTION' }
  view = s.context.project(room, game, '0')
  assert.equal(view.game.myRole.transformed, true)
  assert.equal(view.game.myAction.type, 'WEREWOLF')
  assert.ok(view.game.myAction.wolfTeam.some(item => item.seat === 1))
  game.phase = 'FINISHED'
  assert.equal(s.context.project(room, game, '2').members[0].finalCamp, 'WOLF')
})

test('saved or guarded models do not convert children; simultaneous child death cannot revive or join wolves', () => {
  for (const protection of [{ saved: true }, { guardedSeat: 2 }, { poisonedSeat: 1 }]) {
    const s = server(), seed = fixture(), game = seed.games[0], room = seed.rooms[0]
    game.roles['0'].modelUserId = '1'; game.night = { attackedSeat: 2, ...protection }
    s.rules.resolveNight(game, room)
    assert.equal(isWolf(game.roles['0']), false)
    if (protection.poisonedSeat) assert.equal(game.roles['0'].alive, false)
  }
})

test('converted child participates in wolf suggestions, votes and seer detection; unconverted child is a villager', async () => {
  const seed = fixture(), child = seed.games[0].roles['0']
  child.modelUserId = '4'; seed.games[0].roles['4'].alive = false
  transformWildChildren(seed.games[0])
  seed.games[0].day = 2; seed.games[0].nightStage = 'WEREWOLF'
  const s = server(seed)
  await s.call('suggestWolfTarget', { targetSeat: 1 })
  await s.call('submitNightAction', { targetSeat: 3 })
  assert.equal(s.docs('games')[0].night.cue, 'ACTION')
  await s.call('submitNightAction', { targetSeat: 3 }, '1')
  assert.equal(s.docs('games')[0].night.attackedSeat, 3)
  assert.equal(s.docs('games')[0].night.cue, 'CLOSE')
  const checkSeed = fixture()
  checkSeed.games[0].nightStage = 'SEER'; checkSeed.games[0].roles['0'].faction = 'WOLF'
  const check = server(checkSeed)
  const result = await check.call('submitNightAction', { targetSeat: 1 }, '2')
  assert.equal(result.game.myAction.result, '狼人阵营')
  const goodSeed = fixture(); goodSeed.games[0].nightStage = 'SEER'
  const good = await server(goodSeed).call('submitNightAction', { targetSeat: 1 }, '2')
  assert.equal(good.game.myAction.result, '好人阵营')
})

test('daytime model death converts before entering next night and the child can eliminate its own model', () => {
  const s = server(), seed = fixture(), room = seed.rooms[0], game = seed.games[0]
  game.phase = 'DAY'; game.firstNightRevealed = true; game.roles['0'].modelUserId = '4'
  game.dayState = { stage: 'EXILE_VOTE', exileVotes: Object.fromEntries(room.members.map(item => [item.userId, 5])) }
  s.rules.resolveExileVote(game, room)
  assert.equal(isWolf(game.roles['0']), true)
  assert.equal(game.roles['4'].alive, false)
  assert.equal(s.rules.winner(game, room), '狼人阵营获胜')
  room.config.winMode = '屠城'
  s.rules.enterNextNightOrFinish(game, room)
  assert.equal(game.phase, 'NIGHT')
  assert.equal(game.nightStage, 'WEREWOLF')
  assert.equal(game.day, 2)
})
