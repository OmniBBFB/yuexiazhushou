const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { database } = require('./helpers/database')
const { buildRoles, normalizeConfig } = require('../cloudfunctions/api/room-config')
const { isWolf } = require('../cloudfunctions/api/role-state')
const { splitView } = require('../cloudfunctions/api/state-publisher')
const apiRoot = path.resolve(__dirname, '../cloudfunctions/api')
function fixture(names = ['猎人', '狼王', '狼人', '骑士', '白痴', '守墓人', '村民', '村民']) {
  const members = names.map((role, i) => ({ userId: String(i), openid: String(i), authOpenid: String(i), seat: i + 1, nickname: `玩家${i + 1}`, alive: true, ready: true, roleConfirmed: true }))
  return {
    users: members.map(item => ({ _id: item.userId, openid: item.openid, authOpenid: item.openid, nickname: item.nickname, currentRoomId: 'r' })),
    rooms: [{ _id: 'r', ownerId: '0', code: '123456', version: 1, gameId: 'g', status: 'PLAYING', config: { total: 8, wolves: 2, gods: 4, godRoles: ['猎人', '骑士', '白痴', '守墓人'], wolfRoles: ['狼王'], villagers: 2, interval: 1, winMode: '屠城' }, members }],
    games: [{ _id: 'g', roomId: 'r', phase: 'DAY', day: 2, nightStage: '', night: {}, actions: {}, stageReadyAt: 0, firstNightRevealed: true, sheriffElectionDone: true, confirmedUserIds: [], publicResult: [], dayState: { stage: 'EXILE_VOTE', sheriffSeat: 0, exileVotes: {}, candidates: [], speechQueue: [], speakerSeat: 0, speechDeadline: 0 }, roles: Object.fromEntries(names.map((role, i) => [String(i), { role, alive: true, abilities: {} }])) }],
  }
}
function server(seed = fixture()) {
  let clock = 1000
  const memory = database(seed)
  const context = { exports: {}, Date: class extends Date { static now() { return clock } }, console: { info() {}, error() {} }, require: name => name === 'wx-server-sdk' ? { init() {}, database: () => memory.db, getWXContext: () => ({}) } : name.startsWith('./') ? require(path.join(apiRoot, name)) : require(name) }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(apiRoot, 'index.js'), 'utf8'), context)
  return { ...memory, timer: () => context.exports.main({ Type: 'Timer', TriggerName: 'advanceGames' }), rules: vm.runInContext('rules', context), project: vm.runInContext('project', context), call: (action, payload = {}, user = '0') => context.dispatch(action, { version: memory.docs('rooms')[0].version, ...payload }, user), advance: ms => { clock += ms } }
}
async function exile(s, targetSeat) {
  for (const item of s.docs('rooms')[0].members) if (s.docs('games')[0].roles[item.userId].alive && !(s.docs('games')[0].roles[item.userId].abilities || {}).idiotRevealed) await s.call('exileVote', { targetSeat }, item.userId)
}
test('new role decks preserve size, classic defaults, unique roles and wolf quota', () => {
  const config = fixture().rooms[0].config, deck = buildRoles(config)
  assert.equal(deck.length, 8); assert.equal(deck.filter(role => role === '狼人').length, 1); assert.equal(deck.filter(role => role === '狼王').length, 1)
  for (const role of ['狼人', '狼王', '白狼王']) assert.equal(isWolf({ role }), true)
  assert.deepEqual(normalizeConfig({ total: 12, wolves: 4, gods: 4, villagers: 4, interval: 3, winMode: '屠边' }).godRoles, ['预言家', '女巫', '猎人', '守卫'])
  for (const wolfRoles of [['狼王', '狼王'], ['猎人'], ['狼王', '白狼王']]) assert.throws(() => normalizeConfig({ ...config, wolves: 1, villagers: 3, wolfRoles }), { code: 'BAD_CONFIG' })
})
test('exiled hunter can shoot a wolf king, chained shots defer victory and survive reload', async () => {
  const s = server(); await exile(s, 1)
  assert.equal(s.docs('games')[0].dayState.stage, 'DEATH_SKILL')
  const own = await s.call('getRoom'); assert.equal(own.game.myAction.type, 'SHOOT')
  const other = await s.call('getRoom', {}, '2'); assert.equal(other.game.myAction, undefined)
  await assert.rejects(s.call('shoot', { targetSeat: 3 }, '2'), { code: 'FORBIDDEN' })
  await assert.rejects(s.call('nextNight', {}, '2'), { code: 'WRONG_PHASE' })
  await s.call('shoot', { targetSeat: 2 })
  assert.equal(s.docs('games')[0].dayState.shooterSeat, 2)
  assert.equal(s.docs('games')[0].roles['1'].abilities.shotPending, true)
  const restarted = server({ users: s.docs('users'), rooms: s.docs('rooms'), games: s.docs('games') })
  await restarted.call('shoot', { targetSeat: 3 }, '1')
  assert.equal(restarted.docs('games')[0].phase, 'FINISHED')
  assert.equal(restarted.docs('games')[0].winner, '好人阵营获胜')
})
test('shoot failure rolls back reactions, room projections and command receipt', async () => {
  const s = server(); await exile(s, 1)
  const before = s.docs('games'); s.failWrite(name => name === 'room_signals')
  await assert.rejects(s.call('shoot', { targetSeat: 2, requestId: 'expanded_shoot_000001' }), /injected write failure/)
  assert.deepEqual(s.docs('games'), before); assert.equal(s.docs('command_receipts').length, 0)
  const payload = { version: s.docs('rooms')[0].version, targetSeat: 2, requestId: 'expanded_shoot_000001' }
  s.failWrite(null); await s.call('shoot', payload)
  await s.call('shoot', payload)
  assert.equal(s.docs('games')[0].dayState.shooterSeat, 2)
})
test('death skill times out persistently and bots automatically skip', async () => {
  const s = server(); await exile(s, 1); s.advance(90001); await s.call('getRoom', {}, '2')
  assert.equal(s.docs('games')[0].roles['0'].abilities.shotUsed, true)
  assert.equal(s.docs('games')[0].dayState.stage, 'COMPLETE')
  assert.equal(s.docs('game_tasks').length, 0)
  const seed = fixture(); seed.rooms[0].members[0].isBot = true
  const b = server(seed); await exile(b, 1)
  assert.equal(b.docs('games')[0].dayState.stage, 'COMPLETE')
})
test('knife permits shots but poison, combined knife and poison, duel and white explosion suppress them', () => {
  for (const cause of ['WOLF_ATTACK', 'POISON', 'DUEL', 'WHITE_EXPLOSION', 'EXPLOSION']) {
    const seed = fixture(), s = server(seed), game = seed.games[0], room = seed.rooms[0]
    s.rules.killPlayer(game, room, 1, cause)
    assert.equal(!!game.roles['0'].abilities.shotPending, cause === 'WOLF_ATTACK')
  }
  const seed = fixture(), s = server(seed), game = seed.games[0]
  game.night = { attackedSeat: 1, poisonedSeat: 1 }; s.rules.resolveNight(game, seed.rooms[0])
  assert.equal(game.roles['0'].deathCause, 'POISON'); assert.equal(game.roles['0'].abilities.shotPending, undefined)
})
test('first-night hunter remains hidden through sheriff election and reacts after result confirmation', async () => {
  const seed = fixture(), game = seed.games[0], room = seed.rooms[0], s = server(seed)
  game.day = 1; game.firstNightRevealed = false; game.sheriffElectionDone = false; game.night = { attackedSeat: 1 }
  s.rules.resolveNight(game, room); game.phase = 'DAY'; s.rules.startDay(game, room)
  assert.equal(game.dayState.stage, 'SHERIFF_SIGNUP')
  const view = s.project(room, game, '0'); assert.equal(view.members[0].alive, true); assert.equal(view.game.myAction, undefined)
  s.rules.finishSheriffElection(game, room)
  assert.equal(game.dayState.stage, 'NIGHT_RESULT')
  game.dayState.resultConfirmations = Object.fromEntries(room.members.filter(item => game.roles[item.userId].alive).map(item => [item.userId, true]))
  s.rules.runDayAutomation(game, room)
  assert.equal(game.dayState.stage, 'DEATH_SKILL'); assert.equal(game.dayState.shooterSeat, 1)
})
test('idiot reveals, survives, loses votes and badge, remains a speaker and cannot be exiled again', async () => {
  const seed = fixture(); seed.games[0].dayState.sheriffSeat = 5
  const s = server(seed); await exile(s, 5)
  const game = s.docs('games')[0]; assert.equal(game.roles['4'].alive, true); assert.equal(game.roles['4'].abilities.idiotRevealed, true); assert.equal(game.dayState.sheriffSeat, 0)
  assert.equal(game.lastExile.seat, 0); assert.match(game.voteHistory[0].summary, /白痴/)
  const own = await s.call('getRoom', {}, '4'); assert.equal(own.game.dayView.canExileVote, false); assert.equal(own.members[4].revealedRole, '白痴')
  const next = fixture(); next.games[0].roles['4'] = game.roles['4']; next.games[0].dayState.stage = 'EXILE_VOTE'
  const n = server(next)
  await assert.rejects(n.call('exileVote', { targetSeat: 3 }, '4'), { code: 'WRONG_PHASE' })
  await assert.rejects(n.call('exileVote', { targetSeat: 5 }, '0'), { code: 'BAD_TARGET' })
  await exile(n, 7); assert.equal(n.docs('games')[0].dayState.stage, 'COMPLETE')
  const pure = fixture(); pure.games[0].roles['4'] = game.roles['4']; const p = server(pure)
  assert.equal(p.rules.makeSpeechQueue(pure.rooms[0], pure.games[0], 0, 'ASC').includes(5), true)
  p.rules.killPlayer(pure.games[0], pure.rooms[0], 5, 'POISON'); assert.equal(pure.games[0].roles['4'].alive, false)
})
test('gravekeeper receives only previous actual exile faction privately and confirms before closing', async () => {
  const seed = fixture(), game = seed.games[0]
  game.phase = 'NIGHT'; game.nightStage = 'GRAVEKEEPER'; game.night = { cue: 'OPEN' }; game.lastExile = { day: 1, seat: 2, camp: '狼人阵营' }
  const s = server(seed); await s.call('getRoom', {}, '5'); s.advance(10000)
  const own = await s.call('getRoom', {}, '5')
  assert.equal(own.game.myRole.graveResult.camp, '狼人阵营'); assert.equal(own.game.myAction.type, 'GRAVEKEEPER'); assert.match(own.game.myAction.result, /2号/)
  const split = splitView(own); assert.equal(JSON.stringify(split.publicView).includes('graveResult'), false); assert.equal(split.privateView.game.myRole.graveResult.seat, 2)
  const other = await s.call('getRoom', {}, '0'); assert.equal(other.game.myRole.graveResult, undefined)
  await assert.rejects(s.call('submitNightAction', { confirmResult: true }, '0'), { code: 'FORBIDDEN' })
  await s.call('submitNightAction', { confirmResult: true }, '5'); assert.equal(s.docs('games')[0].night.cue, 'CLOSE')
  assert.equal(s.docs('room_signals').find(item => item._id === '5').state.game.myRole.graveResult.seat, 2)
  assert.equal(JSON.stringify(s.docs('room_states')[0]).includes('graveResult'), false)
})
test('gravekeeper sees no exile for first night, stale record or idiot immunity', async () => {
  for (const lastExile of [undefined, { day: 0, seat: 2, camp: '狼人阵营' }, { day: 1, seat: 0, camp: '' }]) {
    const seed = fixture(), game = seed.games[0]; game.phase = 'NIGHT'; game.nightStage = 'GRAVEKEEPER'; game.night = { cue: 'OPEN' }; game.lastExile = lastExile
    const s = server(seed); await s.call('getRoom', {}, '5'); s.advance(10000); const own = await s.call('getRoom', {}, '5')
    assert.equal(own.game.myRole.graveResult.seat, 0)
  }
})
test('white wolf king replaces a wolf, shares wolf team, validates carry target and bypasses hunter shot', async () => {
  const seed = fixture(); seed.games[0].roles['1'].role = '白狼王'; seed.games[0].dayState.stage = 'SPEECH_ORDER'
  const s = server(seed); await assert.rejects(s.call('wolfExplode', {}, '1'), { code: 'BAD_TARGET' }); await assert.rejects(s.call('wolfExplode', { targetSeat: 2 }, '1'), { code: 'BAD_TARGET' })
  await s.call('wolfExplode', { targetSeat: 1 }, '1')
  const game = s.docs('games')[0]; assert.equal(game.roles['0'].alive, false); assert.equal(game.roles['1'].alive, false); assert.equal(game.roles['0'].abilities.shotPending, undefined); assert.equal(game.phase, 'NIGHT')
  const n = fixture(); n.games[0].roles['1'].role = '白狼王'; n.games[0].phase = 'NIGHT'; n.games[0].nightStage = 'WEREWOLF'; n.games[0].night = { cue: 'ACTION' }
  const w = server(n), view = await w.call('getRoom', {}, '1'); assert.deepEqual(Array.from(view.game.myAction.teammates), [2, 3])
})
test('white wolf explosion before first result preserves night casualties and still resolves pending hunter', async () => {
  const seed = fixture(), game = seed.games[0]; game.day = 1; game.firstNightRevealed = false; game.sheriffElectionDone = false; game.roles['1'].role = '白狼王'; game.roles['0'].alive = false; seed.rooms[0].members[0].alive = false; game.roles['0'].abilities.shotPending = true; game.publicResult = [1]; game.dayState.stage = 'SHERIFF_SIGNUP'; game.dayState.signup = {}
  const s = server(seed); await s.call('wolfExplode', { targetSeat: 7 }, '1')
  assert.deepEqual(s.docs('games')[0].publicResult, [1]); assert.equal(s.docs('games')[0].dayState.stage, 'NIGHT_RESULT')
  s.advance(10000); await s.call('getRoom', {}, '0'); assert.equal(s.docs('games')[0].dayState.stage, 'DEATH_SKILL')
  await s.call('shoot', { targetSeat: 3 }); assert.equal(s.docs('games')[0].phase, 'FINISHED')
})
test('knight duel success ends day, wolf king cannot shoot from duel, and failure resumes correct speaker', async () => {
  const seed = fixture(); seed.games[0].dayState.stage = 'SPEECH_ORDER'; const s = server(seed)
  await assert.rejects(s.call('knightDuel', { targetSeat: 4 }, '3'), { code: 'BAD_TARGET' })
  await s.call('knightDuel', { targetSeat: 2 }, '3')
  const game = s.docs('games')[0]; assert.equal(game.phase, 'NIGHT'); assert.equal(game.roles['1'].abilities.shotPending, undefined); assert.equal(game.roles['3'].abilities.duelUsed, true)
  const failed = fixture(); failed.games[0].dayState = { ...failed.games[0].dayState, stage: 'SPEECH', speakerSeat: 4, speechQueue: [4, 5, 6, 7], speechDeadline: 100000 }
  const f = server(failed); await f.call('knightDuel', { targetSeat: 5 }, '3')
  const result = f.docs('games')[0]; assert.equal(result.roles['3'].alive, false); assert.equal(result.roles['4'].alive, true); assert.equal(result.dayState.stage, 'SPEECH'); assert.equal(result.dayState.speakerSeat, 5)
})
test('day skills reject illegal phases, ordinary wolves cannot carry and revealed identities are public', async () => {
  for (const stage of ['SHERIFF_SIGNUP', 'SHERIFF_VOTE', 'EXILE_VOTE', 'EXILE_PK_SPEECH', 'COMPLETE']) {
    const seed = fixture(); seed.games[0].dayState.stage = stage; seed.games[0].dayState.signup = {}; seed.games[0].dayState.sheriffVotes = {}; seed.games[0].dayState.nightConfirmations = {}; const s = server(seed)
    await assert.rejects(s.call('knightDuel', { targetSeat: 2 }, '3'), { code: 'FORBIDDEN' })
  }
  const seed = fixture(); seed.games[0].dayState.stage = 'SPEECH_ORDER'; const s = server(seed)
  await s.call('wolfExplode', { targetSeat: 7 }, '2'); assert.equal(s.docs('games')[0].roles['6'].alive, true)
})

test('white wolf target validation cannot probe hidden first-night deaths or override their causes', async () => {
  const seed = fixture(), game = seed.games[0]
  game.day = 1; game.firstNightRevealed = false; game.sheriffElectionDone = false; game.roles['1'].role = '白狼王'; game.roles['0'].alive = false; seed.rooms[0].members[0].alive = false; game.roles['0'].deathCause = 'WOLF_ATTACK'; game.roles['0'].abilities.shotPending = true; game.publicResult = [1]; game.dayState.stage = 'SHERIFF_SIGNUP'; game.dayState.signup = {}
  const s = server(seed)
  await s.call('wolfExplode', { targetSeat: 1 }, '1')
  const saved = s.docs('games')[0]; assert.equal(saved.roles['0'].deathCause, 'WOLF_ATTACK'); assert.equal(saved.roles['0'].abilities.shotPending, true); assert.deepEqual(saved.publicResult, [1]); assert.equal(saved.dayState.stage, 'NIGHT_RESULT')
})

test('broadcast heartbeats preserve overdue stages and repair lost close deadlines so gravekeeper can finish', async () => {
  for (const stageDueAt of [900, 0]) {
    const seed = fixture(), game = seed.games[0], room = seed.rooms[0]
    game.phase = 'NIGHT'; game.nightStage = 'GRAVEKEEPER'; game.night = { cue: 'CLOSE', attackedSeat: 7 }; game.stageReadyAt = 900
    Object.assign(room, { broadcasterUserId: '0', broadcastSession: 'broadcast_grave_001', broadcastSessionUserId: '0', broadcastExpiresAt: 9000 })
    seed.game_tasks = [{ _id: 'r', roomId: 'r', gameId: 'g', version: 1, dueAt: stageDueAt || 9000, stageDueAt }]
    const s = server(seed)
    await s.call('heartbeatBroadcast', { sessionId: 'broadcast_grave_001' })
    const task = s.docs('game_tasks')[0]; assert.equal(task.stageDueAt, 900); assert.equal(task.dueAt, 900)
    const result = await s.timer(); assert.equal(result.ok, true); assert.equal(result.data.advanced, 1)
    const saved = s.docs('games')[0]; assert.equal(saved.phase, 'DAWN'); assert.equal(saved.roles['6'].alive, false)
  }
})
test('bot gravekeeper follows open, action and close once, then resolves the night', async () => {
  const seed = fixture(), game = seed.games[0]; seed.rooms[0].members[5].isBot = true
  game.phase = 'NIGHT'; game.nightStage = 'GRAVEKEEPER'; game.night = { cue: 'OPEN', attackedSeat: 7 }; game.stageReadyAt = 900
  const s = server(seed); await s.call('getRoom')
  assert.equal(s.docs('games')[0].night.cue, 'ACTION')
  s.advance(10000); await s.call('getRoom')
  assert.equal(s.docs('games')[0].night.cue, 'CLOSE')
  assert.equal(s.docs('games')[0].actions['2:NIGHT:GRAVEKEEPER:5'].confirmed, true)
  s.advance(10000); await s.call('getRoom'); assert.equal(s.docs('games')[0].phase, 'DAWN')
})
test('renewing a lease while a human gravekeeper is choosing does not create expired action tasks', async () => {
  const seed = fixture(), game = seed.games[0], room = seed.rooms[0]
  game.phase = 'NIGHT'; game.nightStage = 'GRAVEKEEPER'; game.night = { cue: 'ACTION' }; game.stageReadyAt = 900
  Object.assign(room, { broadcasterUserId: '0', broadcastSession: 'broadcast_grave_001', broadcastSessionUserId: '0', broadcastExpiresAt: 9000 })
  seed.game_tasks = [{ _id: 'r', roomId: 'r', gameId: 'g', version: 1, dueAt: 9000, stageDueAt: 0 }]
  const s = server(seed); await s.call('heartbeatBroadcast', { sessionId: 'broadcast_grave_001' })
  assert.equal(s.docs('game_tasks')[0].stageDueAt, 0); assert.equal(s.docs('games')[0].night.cue, 'ACTION')
})

test('personal relation graph uses its own revision and remains isolated from other players and notes', async () => {
  const s = server(), note = { kind: 'relations', targetSeat: -1, revision: 0, edges: [{ source: 1, target: 2, type: 'ATTACK' }] }
  const saved = await s.call('saveNote', { gameId: 'g', note })
  assert.equal(saved.revision, 1)
  assert.equal((await s.call('listNotes', {}, '1')).length, 0)
  await s.call('saveNote', { gameId: 'g', note: { targetSeat: 1, revision: 0, text: '独立文字记录' } })
  await assert.rejects(s.call('saveNote', { gameId: 'g', note }), { code: 'NOTE_CONFLICT' })
  assert.equal((await s.call('listNotes')).length, 2)
  await s.call('saveNote', { gameId: 'g', note: { ...note, revision: 1, edges: [] } })
  const notes = await s.call('listNotes'); assert.equal(notes.find(note => note.kind === 'relations').edges.length, 0)
  assert.equal(notes.find(note => note.targetSeat === 1).text, '独立文字记录')
  await assert.rejects(s.call('saveNote', { gameId: 'other-game', note: { ...note, revision: 2 } }), { code: 'STALE_GAME' })
})

test('sheriff signup and withdrawal are public after signup and persist through subsequent days', async () => {
  const seed = fixture(); const game = seed.games[0]
  game.day = 1; game.sheriffElectionDone = false; game.dayState = { stage: 'SHERIFF_SIGNUP', signup: {}, candidates: [], sheriffVotes: {} }
  const s = server(seed)
  await s.call('sheriffSignup', { join: true }, '0')
  assert.equal((await s.call('getRoom')).game.sheriffElection, null)
  for (let i = 1; i < 8; i++) await s.call('sheriffSignup', { join: i === 1 }, String(i))
  let record = (await s.call('getRoom')).game.sheriffElection
  assert.deepEqual(record.signedSeats, [1, 2]); assert.equal(record.completed, false)
  await s.call('withdrawSheriff', {}, '0')
  record = (await s.call('getRoom')).game.sheriffElection
  assert.deepEqual(record.withdrawnSeats, [1]); assert.deepEqual(record.candidateSeats, [2]); assert.equal(record.sheriffSeat, 2); assert.equal(record.completed, true)
  const persisted = s.docs('games')[0].sheriffElection
  assert.deepEqual(persisted, record)
  const room = s.docs('rooms')[0], current = s.docs('games')[0]
  current.day = 3; current.dayState = { stage: 'SPEECH', signup: {}, candidates: [], sheriffSeat: 0 }
  assert.deepEqual(s.project(room, current, '0').game.sheriffElection, record)
  assert.deepEqual(splitView(s.project(room, current, '0')).publicView.game.sheriffElection, record)
})
