const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { measure, transactionStore, trackChanges, assertResult, runInTransaction } = require('./repository')
const { normalizeConfig, buildRoles } = require('./room-config')
const { listNotes, saveNotes } = require('./notes')
const { resolveIdentity, assertScope, virtualNickname, notificationOpenid } = require('./virtual-users')
let invocationSeen = false
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ok = data => ({ ok: true, data })
const fail = (code, message) => { const e = new Error(message); e.code = code; throw e }
const hashPassword = (value, salt) => value ? crypto.createHash('sha256').update(`${salt}:${String(value)}`).digest('hex') : ''
const shuffle = values => { const result = values.slice(); for (let i = result.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]] } return result }

async function getUser(...args) {
  return require('./auth').createAuth({ db, crypto, fail, virtualNickname }).getUser(...args)
}
async function getRoomByUser(user, store = db) {
  const db = store
  if (!user.currentRoomId) return null
  const roomId = user.currentRoomId
  // An empty successful query proves absence; network/permission failures must propagate.
  const room = store.isTransaction
    ? assertResult(await store.collection('rooms').doc(roomId).get()).data
    : assertResult(await db.collection('rooms').where({ _id: roomId }).limit(1).get()).data[0]
  if (room) assertScope(room, user)
  if (!room || !member(room, user._id)) {
    const repaired = await runInTransaction(db, async transaction => {
      const ref = transaction.collection('users').doc(user._id)
      const latest = assertResult(await ref.get()).data
      if (latest.currentRoomId && latest.currentRoomId !== roomId) fail('STALE_STATE', '房间关联已更新，请重试')
      const currentRoom = assertResult(await transaction.collection('rooms').doc(roomId).get()).data
      if (currentRoom) { assertScope(currentRoom, latest); if (member(currentRoom, user._id)) return currentRoom }
      if (latest.currentRoomId === roomId) await ref.update({ data: { currentRoomId: '', updatedAt: db.serverDate() } })
      return null
    })
    if (repaired) return repaired
    user.currentRoomId = ''
    return null
  }
  return room
}
async function getGame(room, store = db) {
  if (!room || !room.gameId) return null
  // Only a successful empty read proves absence. Transport/permission errors propagate.
  if (store.isTransaction) return assertResult(await store.collection('games').doc(room.gameId).get()).data || null
  return (await store.collection('games').where({ _id: room.gameId }).limit(1).get()).data[0] || null
}
function member(room, userId) { return room.members.find(item => item.userId === userId) }
function assertMember(room, userId) { const value = member(room, userId); if (!value) fail('NOT_MEMBER', '你已不在该房间'); return value }
function assertVersion(room, version) { if (Number(version) !== Number(room.version)) fail('STALE_STATE', '房间状态已更新，请重试') }
function phaseKey(game) { return `${game.day}:${game.phase}:${game.nightStage || ''}` }
function aliveRole(game, userId) { const value = game.roles[userId]; return value && value.alive ? value : null }
// Confirmation eligibility follows disclosed deaths, not hidden night resolution facts.
function publiclyAlive(game, item) {
  const alive = game.roles && game.roles[item.userId] ? game.roles[item.userId].alive : item.alive !== false
  const hiddenNightResult = game.phase !== 'FINISHED' && game.day === 1 && !game.firstNightRevealed
  return alive || !!(hiddenNightResult && (game.publicResult || []).includes(item.seat))
}
function confirmationMembers(game, room) {
  return room.members.filter(item => publiclyAlive(game, item))
}

async function signalRecipients(transaction, members) {
  const humans = [...new Map(members.filter(item => !item.isBot).map(item => [item.userId, item])).values()]
  const recipients = []
  // CloudBase transaction requests must not overlap on the same transaction handle.
  for (const item of humans) {
    const user = !item.openid || item.openid.startsWith('virtual:') && !item.authOpenid
      ? (await transaction.collection('users').doc(item.userId).get()).data : item
    const caller = user.openid.startsWith('virtual:') && (!user.authOpenid || user.authOpenid.startsWith('virtual:')) ? cloud.getWXContext().OPENID : undefined
    recipients.push({ ...item, openid: user.openid, authOpenid: notificationOpenid(user, caller) })
  }
  return recipients
}
async function publishSignals(transaction, room, recipients) {
  if (transaction.isTransaction) {
    if (!transaction.publications) transaction.publications = new Map()
    const pending = transaction.publications.get(room._id)
    const allRecipients = [...new Map([...(pending ? pending.recipients : []), ...recipients].map(item => [item.userId, item])).values()]
    transaction.publications.set(room._id, { room, recipients: allRecipients })
    transaction.beforeFlush = async () => {
      for (const publication of transaction.publications.values()) {
        const latest = transaction.snapshot('rooms', publication.room._id)
        const target = !publication.room.members.length ? { ...publication.room, gameId: '' } : latest || { ...publication.room, members: [], gameId: '' }
        const game = target.gameId ? await getGame(target, transaction) : null
        await require('./state-publisher').publishState(transaction, target, game, publication.recipients, project, Date.now())
      }
    }
    return
  }
  for (const item of recipients) {
    await transaction.collection('room_signals').doc(item.userId).set({ data: {
      _openid: item.authOpenid || item.openid, roomId: member(room, item.userId) ? room._id : '', version: room.version, broadcastVersion: room.broadcastVersion || 0,
    } })
  }
}
async function clearRoomSignals(room) {
  await runInTransaction(db, async transaction => {
    const recipients = await signalRecipients(transaction, room.members)
    await publishSignals(transaction, { ...room, members: [], version: room.version + 1 }, recipients)
  })
}
const broadcast = require('./broadcast').createBroadcast({ db, now: () => Date.now(), fail, getGame, member, assertMember, signalRecipients, publishSignals })
function broadcaster(room) { return broadcast.broadcaster(room) }
function broadcastView(room) { return broadcast.broadcastView(room) }
async function updateBroadcast(...args) { return broadcast.updateBroadcast(...args) }

const rules = require('./game-rules').createGameRules({ now: () => Date.now(), crypto, fail, member, aliveRole, confirmationMembers, publiclyAlive, phaseKey })
const { shoot, duel, canVote, killPlayer, setNightCue, setNightStage, nextStage, resolveNight, winner, voteLeaders, recordVoteResult, beginPkSpeech, advancePkSpeech, makeSpeechQueue, startDay, finishSheriffElection, enterNextNightOrFinish, explodeWolf, resolveSignup, sheriffVoters, finishSheriffSpeeches, advanceSheriffSpeech, canSpeak, resolveSheriffVote, beginSpeech, advanceSpeech, resolveExileVote, runDayAutomation, randomItem, resolveWolfVote, suggestWolfTarget, runBots } = rules

const project = require('./projection').createProjection({ now: () => Date.now(), assertMember, broadcastView, publiclyAlive, confirmationMembers, phaseKey, sheriffVoters, canSpeak })

async function saveRoom(room, data, store = db) {
  const db = store
  return runInTransaction(db, async transaction => {
    const ref = transaction.collection('rooms').doc(room._id)
    const latest = assertResult(await ref.get()).data
    assertVersion(latest, room.version)
    const next = { ...latest, ...data }
    const recipients = await signalRecipients(transaction, [...latest.members, ...next.members])
    if (next.members.some(item => !item.isBot && !item.openid)) data = { ...data, members: next.members.map(item => item.isBot ? item : { ...item, openid: recipients.find(value => value.userId === item.userId).openid }) }
    const selected = member(next, next.broadcasterUserId)
    const fallback = next.broadcasterUserId && (!selected || selected.isBot) ? {
      broadcasterUserId: next.ownerId,
      broadcastVersion: (latest.broadcastVersion || 0) + 1,
      broadcastAvailableAt: Math.max(Date.now(), Number(latest.broadcastExpiresAt || 0)),
      broadcastExpiresAt: 0, broadcastSession: '', broadcastSessionUserId: '',
    } : {}
    const update = { ...data, ...fallback, version: Number(latest.version) + 1, updatedAt: db.serverDate() }
    await ref.update({ data: update })
    await publishSignals(transaction, { ...latest, ...update }, recipients)
    return { ...latest, ...update }
  })
}
async function advanceSnapshot(user, room, game, store) {
  if (room.status !== 'WAITING' && !game) {
    room.status = 'WAITING'; room.gameId = ''
    room.members.forEach(item => { item.ready = !!item.isBot; item.alive = true; item.roleConfirmed = false })
    if (!store) return { changed: true }
    room = await saveRoom(room, { status: room.status, gameId: '', members: room.members }, store)
  }
  if (game && ['ROLE_REVEAL', 'NIGHT', 'DAWN', 'DAY'].includes(game.phase)) {
    const changes = trackChanges({ room, game })
    const phaseBefore = game.phase
    if (game.phase === 'DAY') runDayAutomation(changes.value.game, changes.value.room)
    else runBots(changes.value.game, changes.value.room)
    if (game.phase === 'DAY' && (phaseBefore !== 'DAY' || !game.dayState || !game.dayState.stage)) startDay(changes.value.game, changes.value.room)
    if (changes.changed()) {
      if (!store) return { changed: true }
      await saveDayGame(game, store)
      room = await saveRoom(room, { members: room.members, status: game.phase === 'FINISHED' ? 'FINISHED' : room.status }, store)
    }
  }
  return store ? project(room, game, user._id) : { changed: false }
}
async function viewFor(user, initialRoom, metrics) {
  const room = initialRoom === undefined ? await getRoomByUser(user) : initialRoom
  if (!room) return null
  const game = await getGame(room)
  if ((room.status === 'WAITING' && !game) || (game && game.phase === 'FINISHED')) return project(room, game, user._id)
  const preview = await advanceSnapshot(user, room, game, null)
  if (!preview.changed) return project(room, game, user._id)
  return measure(metrics, 'transactionMs', () => db.runTransaction(async transaction => measure(metrics, 'transactionCallbackMs', async () => {
    if (metrics) metrics.transactionAttempts++
    const store = transactionStore(transaction, db, metrics)
    const latestUser = (await store.collection('users').doc(user._id).get()).data
    if (!latestUser || latestUser.currentRoomId !== room._id) fail('STALE_STATE', '房间关联已更新，请重试')
    const latestRoom = await getRoomByUser(latestUser, store)
    if (!latestRoom) { await store.flush(); return null }
    const result = await advanceSnapshot(latestUser, latestRoom, await getGame(latestRoom, store), store)
    await store.flush()
    return result
  })))
}
async function session(user, metrics) { return { profile: { id: user._id, nickname: user.nickname, gender: user.gender, avatar: user.avatar || '' }, room: await viewFor(user, undefined, metrics) } }

async function dissolveForOwner(room, user, store = db) {
  const db = store
  return runInTransaction(db, async transaction => {
    const ref = transaction.collection('rooms').doc(room._id)
    const latest = assertResult(await ref.get()).data
    assertScope(latest, user)
    if (latest.ownerId !== user._id) fail('FORBIDDEN', '只有房主可以解散房间')
    const claim = latest.code ? (await transaction.collection('room_codes').doc(latest.code).get()).data : null
    const recipients = await signalRecipients(transaction, latest.members)
    const users = []
    for (const item of recipients) users.push(await transaction.collection('users').doc(item.userId).get())
    for (let index = 0; index < recipients.length; index++) {
      if (users[index].data.currentRoomId === latest._id) {
        await transaction.collection('users').doc(recipients[index].userId).update({ data: { currentRoomId: '', updatedAt: db.serverDate() } })
      }
    }
    if (latest.gameId) await transaction.collection('cleanup_tasks').doc(latest.gameId).set({ data: { gameId: latest.gameId, roomId: latest._id, createdAt: db.serverDate() } })
    await publishSignals(transaction, { ...latest, members: [], version: latest.version + 1 }, recipients)
    if (claim && claim.roomId === latest._id) await transaction.collection('room_codes').doc(latest.code).remove()
    await ref.remove()
    return latest.gameId
  })
}

async function removeGameData(gameId) {
  if (!gameId) return
  try {
    assertResult(await db.collection('notes').where({ gameId }).remove())
    assertResult(await db.collection('games').doc(gameId).remove())
    assertResult(await db.collection('cleanup_tasks').doc(gameId).remove())
  } catch (error) { console.error('cleanup failed; task retained', { gameId, code: error.code }) }
}

async function extendSpeech(roomId, userId, version, store = db) {
  const db = store
  return runInTransaction(db, async transaction => {
    const roomRef = transaction.collection('rooms').doc(roomId)
    const room = (await roomRef.get()).data
    const me = assertMember(room, userId)
    assertVersion(room, version)
    const gameRef = transaction.collection('games').doc(room.gameId)
    const game = (await gameRef.get()).data
    const state = game.dayState
    if (game.phase !== 'DAY' || !state || !['SPEECH', 'SHERIFF_SPEECH', 'SHERIFF_PK_SPEECH', 'EXILE_PK_SPEECH'].includes(state.stage)) fail('WRONG_PHASE', '当前不是发言阶段')
    if (!canSpeak(game, me)) fail('FORBIDDEN', '只能延长自己的发言')
    if (Date.now() >= state.speechDeadline) fail('SPEECH_EXPIRED', '本轮发言已结束，不能再延长')
    const used = (game.speechExtensions || {})[userId] || 0
    if (used >= 2) fail('NO_SPEECH_EXTENSION', '本局两次延长机会已用完')
    game.speechExtensions = { ...(game.speechExtensions || {}), [userId]: used + 1 }
    state.speechDeadline += 30000
    const recipients = await signalRecipients(transaction, room.members)
    room.version += 1
    await gameRef.update({ data: { speechExtensions: transaction.command.set(game.speechExtensions), dayState: transaction.command.set(state), updatedAt: db.serverDate() } })
    await roomRef.update({ data: { version: room.version, updatedAt: db.serverDate() } })
    await publishSignals(transaction, room, recipients)
    return project(room, game, userId)
  })
}
async function saveDayGame(game, store = db) {
  const db = store
  await db.collection('games').doc(game._id).update({ data: {
    phase: game.phase, day: game.day, winner: game.winner || '', nightStage: game.nightStage || '', stageReadyAt: game.stageReadyAt || 0,
    sheriffElection: store.command.set(game.sheriffElection || null),
    skillHistory: game.skillHistory || [],
    lastExile: store.command.set(game.lastExile || {}),
    night: store.command.set(game.night || {}), actions: store.command.set(game.actions || {}), roles: store.command.set(game.roles || {}), publicResult: game.publicResult, confirmedUserIds: game.confirmedUserIds,
    dayState: store.command.set(game.dayState || {}), voteHistory: game.voteHistory || (game.dayState && game.dayState.voteResults || []).map(result => ({ ...result, day: game.day })), sheriffElectionDone: !!game.sheriffElectionDone, firstNightRevealed: !!game.firstNightRevealed,
  } })
}
async function dispatch(action, payload, openid, testScope = '', authOpenid = openid, metrics) {
  const user = await measure(metrics, 'identityMs', () => getUser(openid, testScope, authOpenid))
  if (action === 'syncIdentity') return { userId: user._id, openid: user.authOpenid || user.openid, virtual: !!user.testScope }
  if (action === 'session') return session(user, metrics)
  if (action === 'getRoom') return viewFor(user, undefined, metrics)
  if (action === 'subscribeRoom') {
    return runInTransaction(db, async store => {
      const latestUser = (await store.collection('users').doc(user._id).get()).data
      const room = await getRoomByUser(latestUser, store)
      if (!room) return null
      const game = await getGame(room, store)
      const result = await advanceSnapshot(latestUser, room, game, store)
      const latest = store.snapshot('rooms', room._id) || room
      await publishSignals(store, latest, await signalRecipients(store, latest.members))
      return result
    }, metrics)
  }
  if (['heartbeatBroadcast', 'releaseBroadcast'].includes(action)) {
    const room = await getRoomByUser(user)
    if (!room) fail('NO_ROOM', '当前没有房间')
    return updateBroadcast(room._id, user._id, action, payload)
  }
  if (action === 'listNotes') {
    const room = await getRoomByUser(user)
    if (!room) fail('NO_ROOM', '当前没有房间')
    const game = await getGame(room)
    if (!game) fail('NO_GAME', '对局不存在')
    if (payload.gameId && payload.gameId !== game._id) fail('STALE_GAME', '对局已切换，请重新打开笔记')
    return listNotes(db, user._id, game._id)
  }
  const candidate = { roomId: '', gameId: crypto.randomBytes(16).toString('hex') }
  if (action === 'joinRoom') {
    const found = await db.collection('rooms').where({ code: String(payload.code), status: 'WAITING' }).limit(1).get()
    candidate.roomId = found.data[0] && found.data[0]._id
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    if (action === 'createRoom') {
      candidate.code = String(crypto.randomInt(100000, 1000000))
      candidate.roomId = crypto.randomBytes(16).toString('hex')
      // Legacy rooms may not have a room_codes claim yet.
      if ((await db.collection('rooms').where({ code: candidate.code }).limit(1).get()).data.length) continue
    }
    try {
      const committed = await measure(metrics, 'transactionMs', () => db.runTransaction(async transaction => measure(metrics, 'transactionCallbackMs', async () => {
        if (metrics) metrics.transactionAttempts++
    const store = transactionStore(transaction, db, metrics)
        const latestUser = (await store.collection('users').doc(user._id).get()).data
        if (!latestUser || latestUser.openid !== user.openid) fail('UNAUTHENTICATED', '账号状态已更新，请重试')
        let receiptRef = null, fingerprint = ''
        if (payload.requestId !== undefined) {
          if (!/^[a-zA-Z0-9_-]{16,100}$/.test(payload.requestId)) fail('BAD_REQUEST_ID', '请求标识无效')
          fingerprint = crypto.createHash('sha256').update(JSON.stringify({ action, payload })).digest('hex')
          const receiptId = crypto.createHash('sha256').update(`${latestUser._id}:${payload.requestId}`).digest('hex')
          receiptRef = store.collection('command_receipts').doc(receiptId)
          const receipt = (await receiptRef.get()).data
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) fail('REQUEST_MISMATCH', '请求标识不能用于不同操作')
            return { result: receipt.result, cleanupGameId: receipt.cleanupGameId }
          }
        }
        const result = await measure(metrics, 'commandMs', () => mutate(action, payload, latestUser, store, candidate))
        if (receiptRef) await receiptRef.set({ data: { ownerId: latestUser._id, fingerprint, result: JSON.parse(JSON.stringify(result)), cleanupGameId: store.cleanupGameId || '', createdAt: db.serverDate(), expiresAt: new Date(Date.now() + 86400000) } })
        await store.flush()
        return { result, cleanupGameId: store.cleanupGameId }
      })))
      if (committed.cleanupGameId) await measure(metrics, 'cleanupMs', () => removeGameData(committed.cleanupGameId))
      return committed.result
    } catch (error) {
      if (action !== 'createRoom' || error.code !== 'CODE_TAKEN') throw error
    }
  }
  fail('CODE_TAKEN', '暂时无法分配房间号，请重试')
}

async function mutate(action, payload, user, store, candidate) {
  const gameCommand = require('./game-command').createGameCommands({ now: () => Date.now(), _, fail, getGame, saveNotes, assertVersion, extendSpeech, publiclyAlive, aliveRole, member, phaseKey, project, saveRoom, saveDayGame, shoot, duel, canVote, killPlayer, runDayAutomation, finishSheriffSpeeches, advanceSheriffSpeech, suggestWolfTarget, runBots, nextStage, resolveNight, resolveWolfVote, startDay, sheriffVoters, beginSpeech, canSpeak, advancePkSpeech, advanceSpeech, explodeWolf })
  const roomCommand = require('./room-command').createRoomCommands({ fail, normalizeConfig, crypto, hashPassword, getRoomByUser, getGame, saveRoom, signalRecipients, publishSignals, project, assertScope, dissolveForOwner, assertMember, updateBroadcast, assertVersion, shuffle, buildRoles, runBots, gameCommand })
  return roomCommand(action, payload, user, store, candidate)
}

exports.main = async event => {
  const startedAt = Date.now(), firstInvocation = !invocationSeen
  invocationSeen = true
  const traceCandidate = event && (event.traceId || event.payload && event.payload.requestId)
  const requestId = typeof traceCandidate === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(traceCandidate) ? traceCandidate : undefined
  const metrics = { requestId, firstInvocation, transactionAttempts: 0, transactionReads: 0, transactionWrites: 0 }
  try {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID && event && event.Type === 'Timer' && event.TriggerName === 'advanceGames') {
      const summary = await require('./state-worker').advanceDue(db, async roomId => runInTransaction(db, async store => {
        const room = (await store.collection('rooms').doc(roomId).get()).data
        if (!room) { await store.collection('game_tasks').doc(roomId).remove(); return }
        const game = await getGame(room, store)
        await advanceSnapshot({ _id: room.ownerId }, room, game, store)
        const latest = store.snapshot('rooms', roomId) || room
        await publishSignals(store, latest, await signalRecipients(store, latest.members))
      }, metrics), Date.now(), console)
      console.info('api metrics', { action: 'advanceGames', durationMs: Date.now() - startedAt, ...metrics, ...summary })
      return ok(summary)
    }
    const identity = resolveIdentity(OPENID, event && event.testUser)
    const data = await dispatch(event.action, event.payload || {}, identity.openid, identity.testScope, OPENID, metrics)
    const response = event.delivery === 'subscription' && data && data.members ? { accepted: true, requestId: event.payload && event.payload.requestId || '', roomId: data.id, version: data.version } : data
    const room = data && (data.room || data.members && data)
    console.info('api metrics', { transactionCommitAndRetryMs: Math.max(0, (metrics.transactionMs || 0) - (metrics.transactionCallbackMs || 0)), roomId: room && room.id, version: room && room.version, action: event.action, durationMs: Date.now() - startedAt,
      responseBytes: require('buffer').Buffer.byteLength(JSON.stringify(response)), roomSize: room && room.members ? room.members.length : 0, ...metrics })
    return { ...ok(response), identity: { testUser: identity.testScope ? event.testUser : '', protocol: 1 } }
  } catch (error) {
    console.error('api failed', { action: event && event.action, durationMs: Date.now() - startedAt, ...metrics, code: error && error.code, message: error && error.message, stack: error && error.stack })
    const businessCode = error && error.code && !/^(DATABASE_|NETWORK_|INTERNAL_|SDK_)/.test(error.code)
    return { ok: false, error: { code: error && error.code || 'INTERNAL_ERROR', message: businessCode ? error.message : '服务暂时不可用，请重试' } }
  }
}
