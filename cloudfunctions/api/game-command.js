const { isWolf, transformWildChildren } = require('./role-state')
function createGameCommands({ now, _, fail, getGame, saveNotes, assertVersion, extendSpeech, publiclyAlive, aliveRole, member, phaseKey, project, saveRoom, saveDayGame, shoot, duel, canVote, killPlayer, runDayAutomation, finishSheriffSpeeches, advanceSheriffSpeech, suggestWolfTarget, runBots, nextStage, resolveNight, resolveWolfVote, startDay, sheriffVoters, beginSpeech, canSpeak, advancePkSpeech, advanceSpeech, explodeWolf }) {
return async function gameCommand(action, payload, user, store, room) {
  const db = store
  _ = store.command
  const me = member(room, user._id)
  const game = await getGame(room, store); if (!game) fail('NO_GAME', '对局不存在')
  if (['saveNote', 'saveNotes'].includes(action)) return saveNotes(store, user, room, game, payload, action)
  assertVersion(room, payload.version)
  if (action === 'extendSpeech') return extendSpeech(room._id, user._id, payload.version, store)
  if (['shoot', 'knightDuel'].includes(action)) {
    if (action === 'shoot') shoot(game, room, user._id, payload.targetSeat); else duel(game, room, user._id, payload.targetSeat)
    runDayAutomation(game, room); await saveDayGame(game, store)
    return project(await saveRoom(room, { members: room.members, status: room.status }, store), game, user._id)
  }
  if (action === 'withdrawSheriff') {
    const state = game.dayState
    if (game.phase !== 'DAY' || !state || state.stage !== 'SHERIFF_SPEECH') fail('WRONG_PHASE', '只能在竞选发言阶段退水')
    if (!publiclyAlive(game, me) || !(state.signup || {})[user._id] || !state.candidates.includes(me.seat)) fail('FORBIDDEN', '当前不能退水')
    state.withdrawn = { ...(state.withdrawn || {}), [user._id]: true }
    state.candidates = state.candidates.filter(seat => seat !== me.seat)
    if (state.candidates.length <= 1) { state.speechQueue = []; finishSheriffSpeeches(game, room) }
    else if (state.speakerSeat === me.seat) advanceSheriffSpeech(game, room)
    else state.speechQueue = state.speechQueue.filter(seat => seat !== me.seat)
    runDayAutomation(game, room); await saveDayGame(game, store)
    return project(await saveRoom(room, { status: room.status }, store), game, user._id)
  }
  if (action === 'suggestWolfTarget') {
    suggestWolfTarget(game, room, user._id, payload.targetSeat)
    await db.collection('games').doc(game._id).update({ data: { night: _.set(game.night), updatedAt: db.serverDate() } })
    const saved = await saveRoom(room, {}, store)
    return project(saved, game, user._id)
  }
  if (action === 'confirmRole') { if (!aliveRole(game, user._id)) fail('FORBIDDEN', '出局玩家无需阶段确认'); if (game.phase !== 'ROLE_REVEAL') fail('WRONG_PHASE', '身份确认已经结束'); if (!game.confirmedUserIds.includes(user._id)) game.confirmedUserIds.push(user._id); me.roleConfirmed = true; runBots(game, room); await db.collection('games').doc(game._id).update({ data: { phase: game.phase, nightStage: game.nightStage, stageReadyAt: game.stageReadyAt || 0, confirmedUserIds: game.confirmedUserIds, night: _.set(game.night || {}), actions: _.set(game.actions || {}), roles: _.set(game.roles || {}), publicResult: game.publicResult, updatedAt: db.serverDate() } }); const saved = await saveRoom(room, { members: room.members }, store); return project(saved, game, user._id) }
  if (action === 'submitNightAction') {
    if (game.phase !== 'NIGHT') fail('WRONG_PHASE', '当前不是夜间行动阶段'); const mine = aliveRole(game, user._id); if (!mine) fail('FORBIDDEN', '你当前不能行动'); const expected = isWolf(mine) ? 'WEREWOLF' : { '野孩子': 'WILD_CHILD', '狼人': 'WEREWOLF', '预言家': 'SEER', '女巫': 'WITCH', '守卫': 'GUARD', '守墓人': 'GRAVEKEEPER' }[mine.role]; if (expected !== game.nightStage) fail('FORBIDDEN', '当前不是你的行动阶段')
    if ((game.night.cue && game.night.cue !== 'ACTION') || (game.stageReadyAt && now() < game.stageReadyAt)) fail('ANNOUNCEMENT_PLAYING', '请等待本阶段播报结束')
    const target = room.members.find(item => item.seat === Number(payload.targetSeat)); if (payload.targetSeat && (!target || !game.roles[target.userId].alive)) fail('BAD_TARGET', '目标不可选'); const key = phaseKey(game) + ':' + user._id
    const existing = game.actions[key]
    if (existing && !isWolf(mine) && !(mine.role === '预言家' && payload.confirmResult)) return project(room, game, user._id)
    if (mine.role !== '女巫' && mine.role !== '守墓人' && !(mine.role === '预言家' && existing && payload.confirmResult) && !target) fail('BAD_TARGET', '请选择有效目标')
    if (mine.role === '预言家' && target && target.userId === user._id && !(existing && payload.confirmResult)) fail('BAD_TARGET', '预言家不能查验自己')
    if (mine.role === '女巫' && payload.poisonSeat && !room.members.some(item => item.seat === Number(payload.poisonSeat) && game.roles[item.userId].alive)) fail('BAD_TARGET', '毒药目标不可选')
    if (mine.role === '野孩子' && !isWolf(mine)) {
      if (game.day !== 1 || target.userId === user._id) fail('BAD_TARGET', '请选择其他存活玩家作为榜样')
      if (mine.modelUserId && mine.modelUserId !== target.userId) fail('LOCKED', '榜样确认后不能更改')
      mine.modelUserId = target.userId; game.actions[key] = { targetSeat: target.seat }; nextStage(game, room)
    }
    if (isWolf(mine)) { game.actions[key] = { targetSeat: target.seat }; resolveWolfVote(game, room) }
    if (mine.role === '预言家') { const previous = game.actions[key]; if (previous && payload.confirmResult) nextStage(game, room); else game.actions[key] = { targetSeat: target.seat, result: isWolf(game.roles[target.userId]) ? '狼人阵营' : '好人阵营' } }
    if (mine.role === '女巫') { const useSave = !!payload.useSave; const poisonSeat = Number(payload.poisonSeat || 0); if (useSave && poisonSeat) fail('WITCH_MEDICINE_CONFLICT', '同一晚不能同时使用解药和毒药'); if (useSave && !mine.abilities.antidote) fail('NO_ANTIDOTE', '解药已经使用'); if (poisonSeat && !mine.abilities.poison) fail('NO_POISON', '毒药已经使用'); if (useSave) { mine.abilities.antidote = false; game.night.saved = true } if (poisonSeat) { mine.abilities.poison = false; game.night.poisonedSeat = poisonSeat } game.actions[key] = { useSave, poisonSeat }; nextStage(game, room) }
    if (mine.role === '守墓人') { game.actions[key] = { confirmed: true }; nextStage(game, room) }
    if (mine.role === '守卫') { if (mine.abilities.lastGuardedSeat === target.seat) fail('SAME_GUARD', '不能连续两晚守护同一玩家'); mine.abilities.lastGuardedSeat = target.seat; game.night.guardedSeat = target.seat; game.actions[key] = { targetSeat: target.seat }; nextStage(game, room) }
    if (game.nightStage === 'RESOLVE') resolveNight(game, room); runBots(game, room)
    await saveDayGame(game, store); const saved = await saveRoom(room, { members: room.members }, store); return project(saved, game, user._id)
  }
  if (action === 'confirmDawn') { if (!publiclyAlive(game, me)) fail('FORBIDDEN', '出局玩家无需阶段确认'); if (game.phase !== 'DAWN') fail('WRONG_PHASE', '当前不是天亮阶段'); if (!game.confirmedUserIds.includes(user._id)) game.confirmedUserIds.push(user._id); runBots(game, room); if (game.phase === 'DAY') startDay(game, room); await saveDayGame(game, store); const saved = await saveRoom(room, { members: room.members, status: room.status }, store); return project(saved, game, user._id) }
  if (action === 'sheriffSignup') { if (game.phase !== 'DAY' || !game.dayState || game.dayState.stage !== 'SHERIFF_SIGNUP' || (!game.roles[user._id].alive && game.firstNightRevealed)) fail('WRONG_PHASE', '当前不能报名竞选'); game.dayState.signup[user._id] = !!payload.join; runDayAutomation(game, room); await saveDayGame(game, store); const saved = await saveRoom(room, { status: room.status }, store); return project(saved, game, user._id) }
  if (action === 'sheriffVote') { if (game.phase !== 'DAY' || !game.dayState || game.dayState.stage !== 'SHERIFF_VOTE' || (!game.roles[user._id].alive && game.firstNightRevealed)) fail('WRONG_PHASE', '当前不能进行警长投票'); if (!sheriffVoters(game, room).some(item => item.userId === user._id)) fail('FORBIDDEN', '上警玩家（包括退水玩家）不能投票'); const target = Number(payload.targetSeat); if (!game.dayState.candidates.includes(target)) fail('BAD_TARGET', '请选择竞选玩家'); game.dayState.sheriffVotes[user._id] = target; runDayAutomation(game, room); await saveDayGame(game, store); const saved = await saveRoom(room, { status: room.status }, store); return project(saved, game, user._id) }
  if (action === 'confirmFirstNightResult') { if (!aliveRole(game, user._id)) fail('FORBIDDEN', '出局玩家无需阶段确认'); if (game.phase !== 'DAY' || !game.dayState || game.dayState.stage !== 'NIGHT_RESULT') fail('WRONG_PHASE', '当前不是首夜结果阶段'); if (game.dayState.nextAfterResult === 'EXPLOSION') fail('ANNOUNCEMENT_PLAYING', '首夜结果公布后将自动进入下一阶段'); game.dayState.resultConfirmations[user._id] = true; runDayAutomation(game, room); await saveDayGame(game, store); const saved = await saveRoom(room, { status: room.status }, store); return project(saved, game, user._id) }
  if (action === 'setSpeechOrder') { if (game.phase !== 'DAY' || !game.dayState || game.dayState.stage !== 'SPEECH_ORDER') fail('WRONG_PHASE', '当前不能设置发言顺序'); const sheriff = room.members.find(item => item.seat === game.dayState.sheriffSeat); if ((sheriff ? sheriff.userId : room.ownerId) !== user._id) fail('FORBIDDEN', '当前由警长决定发言顺序'); beginSpeech(game, room, payload.direction === 'DESC' ? 'DESC' : 'ASC'); runDayAutomation(game, room); await saveDayGame(game, store); const saved = await saveRoom(room, { status: room.status }, store); return project(saved, game, user._id) }
  if (action === 'finishSpeech') { if (game.phase !== 'DAY' || !game.dayState || !['SPEECH', 'SHERIFF_SPEECH', 'SHERIFF_PK_SPEECH', 'EXILE_PK_SPEECH'].includes(game.dayState.stage)) fail('WRONG_PHASE', '当前不是发言阶段'); if (!canSpeak(game, me)) fail('FORBIDDEN', '当前不是你的发言回合'); if (game.dayState.stage === 'SHERIFF_SPEECH') advanceSheriffSpeech(game, room); else if (['SHERIFF_PK_SPEECH', 'EXILE_PK_SPEECH'].includes(game.dayState.stage)) advancePkSpeech(game); else advanceSpeech(game); runDayAutomation(game, room); await saveDayGame(game, store); const saved = await saveRoom(room, { status: room.status }, store); return project(saved, game, user._id) }
  if (action === 'exileVote') { if (game.phase !== 'DAY' || !game.dayState || game.dayState.stage !== 'EXILE_VOTE' || !game.roles[user._id].alive || !canVote(game, me)) fail('WRONG_PHASE', '当前不能进行放逐投票'); const target = Number(payload.targetSeat || 0); if (target && !room.members.some(item => item.seat === target && game.roles[item.userId].alive && !(game.roles[item.userId].abilities || {}).idiotRevealed)) fail('BAD_TARGET', '请选择可放逐的存活玩家'); if (target && game.dayState.exileRound === 2 && !(game.dayState.pkCandidates || []).includes(target)) fail('BAD_TARGET', '请选择本轮 PK 玩家'); game.dayState.exileVotes[user._id] = target; runDayAutomation(game, room); await saveDayGame(game, store); const saved = await saveRoom(room, { members: room.members, status: room.status }, store); return project(saved, game, user._id) }
  if (action === 'wolfExplode') { explodeWolf(game, room, user._id, payload.targetSeat); await saveDayGame(game, store); return project(await saveRoom(room, { status: room.status, members: room.members }, store), game, user._id) }
  if (action === 'updateAlive') { if (game.phase !== 'DAY' || room.ownerId !== user._id) fail('FORBIDDEN', '只有房主可在白天更新出局状态'); const target = room.members.find(item => item.seat === Number(payload.seat)); if (!target) fail('BAD_TARGET', '玩家不存在'); target.alive = !!payload.alive; game.roles[target.userId].alive = !!payload.alive; transformWildChildren(game); await db.collection('games').doc(game._id).update({ data: { roles: game.roles } }); const saved = await saveRoom(room, { members: room.members }, store); return project(saved, game, user._id) }
  if (action === 'nextNight') { if (game.phase !== 'DAY' || !game.dayState || game.dayState.stage !== 'COMPLETE') fail('WRONG_PHASE', '白天流程尚未完成'); if (!aliveRole(game, user._id)) fail('FORBIDDEN', '出局玩家无需确认进入下一夜'); game.dayState.nightConfirmations = game.dayState.nightConfirmations || {}; game.dayState.nightConfirmations[user._id] = true; runDayAutomation(game, room); await saveDayGame(game, store); const saved = await saveRoom(room, { status: room.status, members: room.members }, store); return project(saved, game, user._id) }
  if (action === 'finishGame') { if (room.ownerId !== user._id) fail('FORBIDDEN', '只有房主可以结束本局'); game.phase = 'FINISHED'; game.winner = '本局由玩家确认结束'; room.status = 'FINISHED'; await db.collection('games').doc(game._id).update({ data: { phase: game.phase, winner: game.winner } }); const saved = await saveRoom(room, { status: room.status }, store); return project(saved, game, user._id) }
  if (action === 'nextGame') { if (room.status !== 'FINISHED') fail('WRONG_PHASE', '当前对局尚未结束'); if (room.ownerId !== user._id) fail('FORBIDDEN', '只有房主可以发起下一局'); room.status = 'WAITING'; room.gameId = ''; room.members.forEach(item => { item.ready = !!item.isBot; item.alive = true; item.roleConfirmed = false }); const saved = await saveRoom(room, { status: room.status, gameId: '', members: room.members }, store); return project(saved, null, user._id) }
  fail('UNKNOWN_ACTION', '未知操作')
}
}
module.exports = { createGameCommands }
