function createRoomCommands({ fail, normalizeConfig, crypto, hashPassword, getRoomByUser, getGame, saveRoom, signalRecipients, publishSignals, project, assertScope, dissolveForOwner, assertMember, updateBroadcast, assertVersion, shuffle, buildRoles, runBots, gameCommand }) {
return async function roomCommand(action, payload, user, store, candidate) {
  const db = store
  if (action === 'updateProfile') {
    const nickname = String(payload.nickname || '').trim().slice(0, 12); const gender = ['保密', '男', '女'].includes(payload.gender) ? payload.gender : '保密'
    if (!nickname) fail('BAD_PROFILE', '昵称不能为空')
    let room = await getRoomByUser(user, store); if (room) { room.members.forEach(item => { if (item.userId === user._id) item.nickname = nickname }); room = await saveRoom(room, { members: room.members }, store) }
    await db.collection('users').doc(user._id).update({ data: { nickname, gender, updatedAt: db.serverDate() } })
    return { profile: { id: user._id, nickname, gender, avatar: user.avatar || '' }, room: room ? project(room, await getGame(room, store), user._id) : null }
  }
  if (action === 'createRoom') {
    if (await getRoomByUser(user, store)) fail('ALREADY_IN_ROOM', '请先退出当前房间')
    const config = normalizeConfig(payload.config)
    const code = candidate.code
    const claim = (await db.collection('room_codes').doc(code).get()).data
    if (claim) fail('CODE_TAKEN', '房间号冲突，请重试')
    const passwordSalt = crypto.randomBytes(16).toString('hex'); const room = { code, testScope: user.testScope || '', ownerId: user._id, status: 'WAITING', config, passwordSalt, passwordHash: hashPassword(payload.config.password, passwordSalt), members: [{ userId: user._id, openid: user.openid, authOpenid: user.authOpenid, nickname: user.nickname, seat: 0, ready: false, alive: true, roleConfirmed: false, isBot: false }], gameId: '', version: 1, createdAt: db.serverDate(), updatedAt: db.serverDate() }
    const recipients = await signalRecipients(store, room.members)
    room._id = candidate.roomId
    await db.collection('rooms').doc(room._id).set({ data: room })
    await db.collection('room_codes').doc(code).set({ data: { roomId: room._id } })
    await db.collection('users').doc(user._id).update({ data: { currentRoomId: room._id } })
    await publishSignals(store, room, recipients)
    return project(room, null, user._id)
  }
  if (action === 'joinRoom') {
    const existing = await getRoomByUser(user, store)
    if (existing) return project(existing, await getGame(existing, store), user._id)
    const room = candidate.roomId ? (await db.collection('rooms').doc(candidate.roomId).get()).data : null
    if (!room || room.status !== 'WAITING' || room.code !== String(payload.code)) fail('ROOM_NOT_FOUND', '房间不存在或已经开始'); assertScope(room, user); if (room.passwordHash !== hashPassword(payload.password, room.passwordSalt)) fail('BAD_PASSWORD', '房间密码错误'); if (room.members.length >= room.config.total) fail('ROOM_FULL', '房间已满')
    room.members.push({ userId: user._id, openid: user.openid, authOpenid: user.authOpenid, nickname: user.nickname, seat: 0, ready: false, alive: true, roleConfirmed: false, isBot: false }); const saved = await saveRoom(room, { members: room.members }, store); await db.collection('users').doc(user._id).update({ data: { currentRoomId: room._id } }); return project(saved, null, user._id)
  }
  if (['exitRoom', 'forceLeaveRoom', 'leaveRoom', 'dissolveRoom'].includes(action)) {
    const targetRoom = await getRoomByUser(user, store)
    if (action === 'dissolveRoom' && targetRoom && targetRoom.ownerId !== user._id) fail('FORBIDDEN', '只有房主可以解散房间')
    if (targetRoom && targetRoom.ownerId === user._id) {
      const gameId = await dissolveForOwner(targetRoom, user, store)
      store.cleanupGameId = gameId
    } else {
      if (targetRoom && targetRoom.status === 'WAITING') { targetRoom.members = targetRoom.members.filter(item => item.userId !== user._id); await saveRoom(targetRoom, { members: targetRoom.members }, store) }
      await db.collection('users').doc(user._id).update({ data: { currentRoomId: '', updatedAt: db.serverDate() } })
    }
    return { profile: { id: user._id, nickname: user.nickname, gender: user.gender, avatar: user.avatar || '' }, room: null }
  }
  const room = await getRoomByUser(user, store); if (!room) fail('NO_ROOM', '当前没有房间'); const me = assertMember(room, user._id)
  if (action === 'transferBroadcast') return updateBroadcast(room._id, user._id, action, payload, store)
  if (action === 'rotateSeats') {
    if (room.ownerId !== user._id) fail('FORBIDDEN', '只有房主可以轮换座位')
    assertVersion(room, payload.version)
    if (room.status !== 'WAITING') fail('LOCKED', '对局开始后不能轮换座位')
    const members = room.members.map(item => ({ ...item, seat: item.seat ? item.seat % room.config.total + 1 : 0, ready: !!item.isBot && !!item.seat }))
    const saved = await saveRoom(room, { members }, store)
    return project(saved, null, user._id)
  }
  if (action === 'readyVirtualPlayers') {
    if (room.ownerId !== user._id) fail('FORBIDDEN', '只有房主可以一键准备')
    if (!user.testScope || room.testScope !== user.testScope) fail('TEST_FORBIDDEN', '仅虚拟测试房间支持一键准备')
    assertVersion(room, payload.version)
    if (room.status !== 'WAITING') fail('LOCKED', '对局开始后不能一键准备')
    const members = []
    for (const item of room.members) {
      if (item.isBot || !item.seat) { members.push(item); continue }
      const openid = item.openid || (await db.collection('users').doc(item.userId).get()).data.openid
      const virtual = openid.startsWith(`virtual:${user.testScope}:`)
      members.push(virtual ? { ...item, ready: true } : item)
    }
    return project(await saveRoom(room, { members }, store), null, user._id)
  }
  if (action === 'selectSeat') { assertVersion(room, payload.version); if (room.status !== 'WAITING') fail('LOCKED', '座位已经锁定'); const seat = Number(payload.seat); if (!Number.isInteger(seat) || seat < 1 || seat > room.config.total || room.members.some(item => item.userId !== user._id && item.seat === seat)) fail('SEAT_TAKEN', '该座位已被占用'); me.seat = seat; me.ready = false; const saved = await saveRoom(room, { members: room.members }, store); return project(saved, null, user._id) }
  if (action === 'setReady') { if (room.status !== 'WAITING') fail('LOCKED', '对局开始后不能修改准备状态'); assertVersion(room, payload.version); if (!me.seat) fail('NO_SEAT', '请先选择座位'); me.ready = !!payload.ready; const saved = await saveRoom(room, { members: room.members }, store); return project(saved, null, user._id) }
  if (action === 'addBots') { assertVersion(room, payload.version); if (room.ownerId !== user._id || room.status !== 'WAITING') fail('FORBIDDEN', '只有房主可添加测试机器人'); const used = new Set(room.members.map(item => item.seat)); const names = ['夜鸦', '银月', '雾松', '星火', '长风', '白露', '青崖', '流萤', '玄木', '霜河', '远山']; for (let seat = 1; seat <= room.config.total && room.members.length < room.config.total; seat += 1) { if (!used.has(seat)) room.members.push({ userId: `bot:${crypto.randomBytes(8).toString('hex')}`, nickname: `${names[(seat - 1) % names.length]}·BOT`, seat, ready: true, alive: true, roleConfirmed: false, isBot: true }) } const saved = await saveRoom(room, { members: room.members }, store); return project(saved, null, user._id) }
  if (action === 'startGame') {
    assertVersion(room, payload.version); if (room.status !== 'WAITING') fail('LOCKED', '当前不能开始新对局'); if (room.ownerId !== user._id) fail('FORBIDDEN', '只有房主可以开始'); if (room.members.length !== room.config.total || room.members.some(item => !item.seat || !item.ready)) fail('NOT_READY', '需要全员入座并准备')
    const shuffled = shuffle(buildRoles(room.config)); const sorted = room.members.slice().sort((a, b) => a.seat - b.seat); const roles = {}
    sorted.forEach((item, index) => { roles[item.userId] = { role: shuffled[index], faction: ['狼人', '白狼王', '狼王'].includes(shuffled[index]) ? 'WOLF' : 'VILLAGE', alive: true, abilities: shuffled[index] === '女巫' ? { antidote: true, poison: true } : shuffled[index] === '守卫' ? { lastGuardedSeat: 0 } : {} }; item.alive = true; item.roleConfirmed = false })
    const game = { roomId: room._id, round: 1, phase: 'ROLE_REVEAL', nightStage: '', stageReadyAt: 0, day: 1, roles, actions: {}, night: {}, dayState: {}, voteHistory: [], sheriffElectionDone: false, firstNightRevealed: false, confirmedUserIds: [], publicResult: [], winner: '', createdAt: db.serverDate(), updatedAt: db.serverDate() }; runBots(game, room)
    game._id = candidate.gameId; await db.collection('games').doc(game._id).set({ data: game }); room.gameId = game._id; room.status = 'PLAYING'; room.members = sorted; const saved = await saveRoom(room, { gameId: game._id, status: room.status, members: sorted }, store); return project(saved, game, user._id)
  }
  return gameCommand(action, payload, user, store, room)
}
}
module.exports = { createRoomCommands }
