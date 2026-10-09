const { electionFor } = require('./sheriff-record')
// Pure game rules: no database or device I/O. Clock and randomness are injected.
const { isWolf, transformWildChildren, transformationVisible } = require('./role-state')
function createGameRules({ now, crypto, fail, member, aliveRole, confirmationMembers, publiclyAlive, phaseKey }) {
function setNightCue(game, room, cue) {
  // Rounded bundled MP3 durations, plus 150ms margin; never wait for an audio ACK.
  const interval = Math.max(1, Math.min(6, Number(room.config.interval) || 3))
  const durations = { WILD_CHILD: { OPEN: 1600, ACTION: 1900, CLOSE: 1500 }, WEREWOLF: { OPEN: 1250, ACTION: 1450, CLOSE: 1250 }, SEER: { OPEN: 1450, ACTION: 1700, CLOSE: 1400 }, WITCH: { OPEN: 1150, ACTION: 1350, CLOSE: 1100 }, GUARD: { OPEN: 1250, ACTION: 1450, CLOSE: 1200 }, GRAVEKEEPER: { OPEN: 1150, ACTION: 1950, CLOSE: 1150 } }
  const promptMs = cue === 'START' ? 1550 : (durations[game.nightStage] || {})[cue] || 1700
  game.night.cue = cue
  if (game.nightStage === 'GRAVEKEEPER' && cue === 'ACTION') for (const role of Object.values(game.roles)) if (role.role === '守墓人' && role.alive) { role.abilities = role.abilities || {}; role.abilities.graveResult = game.lastExile && game.lastExile.day === game.day - 1 ? { ...game.lastExile } : { day: game.day - 1, seat: 0, camp: '' } }
  const role = { WILD_CHILD: '野孩子', WEREWOLF: '狼人', SEER: '预言家', WITCH: '女巫', GUARD: '守卫', GRAVEKEEPER: '守墓人' }[game.nightStage]
  const inactiveRole = role && !Object.values(game.roles).some(item => (role === '狼人' ? isWolf(item) : item.role === role) && item.alive)
  const windowMs = cue === 'ACTION' && inactiveRole ? crypto.randomInt(5, 21) * 1000
    : cue === 'ACTION' ? Math.max(interval * 1000, promptMs + 150) : promptMs + 150 + interval * 1000
  game.stageReadyAt = now() + windowMs
}
function setNightStage(game, room, stage) { const first = stage === 'WILD_CHILD' || stage === 'WEREWOLF' && game.nightStage !== 'WILD_CHILD'; game.nightStage = stage; setNightCue(game, room, first ? 'START' : 'OPEN') }
function nextStage(game, room) {
  if (game.night.cue !== 'CLOSE') { setNightCue(game, room, 'CLOSE'); return false }
  const order = ['WILD_CHILD', 'WEREWOLF', 'SEER', 'WITCH', 'GUARD', 'GRAVEKEEPER']
  let index = order.indexOf(game.nightStage) + 1
  while (index < order.length) {
    const stage = order[index]; const role = { SEER: '预言家', WITCH: '女巫', GUARD: '守卫', GRAVEKEEPER: '守墓人' }[stage]
    if (!role || Object.values(game.roles).some(item => item.role === role)) { setNightStage(game, room, stage); return false }
    index += 1
  }
  setNightStage(game, room, 'RESOLVE'); return true
}
function resolveNight(game, room) {
  const deaths = []
  const attacked = game.night.attackedSeat || 0
  const saved = !!game.night.saved
  const guarded = game.night.guardedSeat || 0
  if (attacked && !saved && attacked !== guarded) deaths.push(attacked)
  if (game.night.poisonedSeat && !deaths.includes(game.night.poisonedSeat)) deaths.push(game.night.poisonedSeat)
  deaths.forEach(seat => killPlayer(game, room, seat, seat === game.night.poisonedSeat ? 'POISON' : 'WOLF_ATTACK', true))
  transformWildChildren(game)
  game.publicResult = deaths; game.phase = 'DAWN'; game.nightStage = ''; game.stageReadyAt = 0; game.confirmedUserIds = []
}
// Deaths are recorded before reactions; reactions finish before the next phase or victory.
function recordSkill(game, text) { game.skillHistory = [...(game.skillHistory || []), { day: game.day, text }] }
function killPlayer(game, room, seat, cause, deferTransformation = false) {
  const target = room.members.find(item => item.seat === seat)
  if (!target || !game.roles[target.userId].alive) return
  const role = game.roles[target.userId]
  target.alive = false; role.alive = false; role.deathCause = cause
  role.abilities = role.abilities || {}
  if (['猎人', '狼王'].includes(role.role) && ['WOLF_ATTACK', 'EXILE', 'SHOT'].includes(cause) && !role.abilities.shotUsed) role.abilities.shotPending = true
  if (!(game.day === 1 && !game.firstNightRevealed) && game.dayState && game.dayState.sheriffSeat === seat) game.dayState.sheriffSeat = 0
  if (!deferTransformation) transformWildChildren(game)
}
function beginDeathSkills(game, room, resume) {
  const pending = room.members.filter(item => game.roles[item.userId].abilities && game.roles[item.userId].abilities.shotPending).sort((a, b) => a.seat - b.seat)
  if (!pending.length) return false
  const state = game.dayState
  state.deathResume = resume; state.stage = 'DEATH_SKILL'; state.shooterSeat = pending[0].seat
  state.speechDeadline = now() + 90000; state.speakerSeat = 0
  return true
}
function finishDeathSkills(game, room) {
  const state = game.dayState, resume = state.deathResume || 'SPEECH_ORDER'
  if (beginDeathSkills(game, room, resume)) return
  state.stage = resume; state.shooterSeat = 0; state.speechDeadline = 0; delete state.deathResume
  const sheriff = room.members.find(item => item.seat === state.sheriffSeat)
  if (sheriff && !game.roles[sheriff.userId].alive) state.sheriffSeat = 0
  const result = winner(game, room)
  if (result) { game.phase = 'FINISHED'; game.winner = result; room.status = 'FINISHED' }
  else if (resume === 'NEXT_NIGHT') enterNextNightOrFinish(game, room)
}
function shoot(game, room, userId, targetSeat) {
  const state = game.dayState, role = game.roles[userId], me = member(room, userId)
  if (game.phase !== 'DAY' || !state || state.stage !== 'DEATH_SKILL' || !me || state.shooterSeat !== me.seat || !role.abilities.shotPending) fail('FORBIDDEN', '当前不能开枪')
  const seat = Number(targetSeat || 0)
  if (!Number.isInteger(seat) || seat && !room.members.some(item => item.seat === seat && game.roles[item.userId].alive)) fail('BAD_TARGET', '请选择存活目标，或放弃开枪')
  role.abilities.shotPending = false; role.abilities.shotUsed = true; role.abilities.revealed = true
  if (seat) killPlayer(game, room, seat, 'SHOT')
  state.resultText = `${me.seat}号${role.role}${seat ? '开枪带走' + seat + '号' : '放弃开枪'}`
  recordSkill(game, state.resultText)
  finishDeathSkills(game, room)
}
function duel(game, room, userId, targetSeat) {
  const state = game.dayState, mine = aliveRole(game, userId), me = member(room, userId)
  if (game.phase !== 'DAY' || !state || !['SPEECH_ORDER', 'SPEECH'].includes(state.stage) || !mine || mine.role !== '骑士' || mine.abilities.duelUsed) fail('FORBIDDEN', '当前不能决斗')
  const target = room.members.find(item => item.seat === Number(targetSeat))
  if (!target || target.userId === userId || !game.roles[target.userId].alive) fail('BAD_TARGET', '请选择其他存活玩家')
  mine.abilities.duelUsed = true; mine.abilities.revealed = true
  if (isWolf(game.roles[target.userId])) {
    killPlayer(game, room, target.seat, 'DUEL'); state.resultText = `${me.seat}号骑士决斗成功，${target.seat}号出局`; recordSkill(game, state.resultText)
    if (!beginDeathSkills(game, room, 'NEXT_NIGHT')) enterNextNightOrFinish(game, room)
  } else {
    killPlayer(game, room, me.seat, 'DUEL'); state.resultText = `${me.seat}号骑士决斗失败，骑士出局`; recordSkill(game, state.resultText)
    state.speechQueue = (state.speechQueue || []).filter(seat => seat !== me.seat)
    if (state.speakerSeat === me.seat) { state.speakerSeat = state.speechQueue[0] || 0; state.speechDeadline = state.speakerSeat ? now() + 90000 : 0; if (!state.speakerSeat) state.stage = 'EXILE_VOTE' }
    const result = winner(game, room); if (result) { game.phase = 'FINISHED'; game.winner = result; room.status = 'FINISHED' }
  }
}
function canVote(game, item) { return !(game.roles[item.userId].abilities || {}).idiotRevealed }
function winner(game, room) {
  transformWildChildren(game)
  const entries = room.members.filter(item => game.roles[item.userId].alive)
  const wolves = entries.filter(item => isWolf(game.roles[item.userId])).length
  const villagers = entries.filter(item => ['村民', '野孩子'].includes(game.roles[item.userId].role) && !isWolf(game.roles[item.userId])).length
  const gods = entries.length - wolves - villagers
  if (!wolves) return '好人阵营获胜'
  if (wolves >= entries.length - wolves) return '狼人阵营获胜'
  if (room.config.winMode === '屠边' && (!villagers || !gods)) return '狼人阵营获胜'
  return ''
}

function voteLeaders(votes, game, room, eligible) {
  // Integer half-vote units avoid floating-point ambiguity: ordinary=2, sheriff=3.
  const counts = {}
  for (const player of eligible) {
    const seat = Number(votes[player.userId] || 0)
    if (!seat) continue
    const weight = player.seat === game.dayState.sheriffSeat ? 3 : 2
    counts[seat] = (counts[seat] || 0) + weight
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return ranked.length ? ranked.filter(item => item[1] === ranked[0][1]).map(item => Number(item[0])).sort((a, b) => a - b) : []
}
function recordVoteResult(game, votes, eligible, kind, leaders) {
  const state = game.dayState, totals = {}, abstainedSeats = []
  for (const player of eligible) {
    const seat = Number(votes[player.userId] || 0)
    if (!seat) { abstainedSeats.push(player.seat); continue }
    if (!totals[seat]) totals[seat] = { seat, votes: 0, voterSeats: [], sheriffVoterSeats: [] }
    const sheriff = player.seat === state.sheriffSeat
    totals[seat].votes += sheriff ? 1.5 : 1
    totals[seat].voterSeats.push(player.seat)
    if (sheriff) totals[seat].sheriffVoterSeats.push(player.seat)
  }
  const round = (kind === 'SHERIFF' ? state.sheriffRound : state.exileRound) || 1
  const summary = leaders.length > 1 ? (round === 1 ? `${leaders.join('、')}号平票，进入 PK` : kind === 'SHERIFF' ? '再次平票，警徽流失' : '再次平票，无人出局')
    : leaders.length === 1 ? `${leaders[0]}号${kind === 'SHERIFF' ? '当选警长' : '被放逐'}` : kind === 'SHERIFF' ? '无人得票，无警长' : '无人得票，无人出局'
  const report = { kind, round, summary, totals: Object.values(totals).sort((a, b) => a.seat - b.seat), abstainedSeats }
  state.voteResults = [...(state.voteResults || []), report]
  // Only resolved rounds enter history. Preserve known legacy results on first write.
  game.voteHistory = [...(game.voteHistory || (state.voteResults.slice(0, -1).map(result => ({ ...result, day: game.day })))), { ...report, day: game.day }]
}
function beginPkSpeech(game, seats, kind) {
  const state = game.dayState
  state.pkCandidates = seats; state.speechQueue = seats.slice(); state.speakerSeat = seats[0]
  state.speechDeadline = now() + 90000; state.stage = kind === 'SHERIFF' ? 'SHERIFF_PK_SPEECH' : 'EXILE_PK_SPEECH'
  if (kind === 'SHERIFF') { state.sheriffRound = 2; state.candidates = seats; state.sheriffVotes = {} }
  else { state.exileRound = 2; state.exileVotes = {} }
}
function advancePkSpeech(game) {
  const state = game.dayState, voteStage = state.stage === 'SHERIFF_PK_SPEECH' ? 'SHERIFF_VOTE' : 'EXILE_VOTE'
  state.speechQueue.shift(); state.speakerSeat = state.speechQueue[0] || 0
  state.speechDeadline = state.speakerSeat ? now() + 90000 : 0
  if (!state.speakerSeat) state.stage = voteStage
}
function makeSpeechQueue(room, game, referenceSeat, direction) {
  const seats = room.members.filter(item => game.roles[item.userId].alive).map(item => item.seat).sort((a, b) => a - b)
  if (direction === 'DESC') seats.reverse()
  const startIndex = seats.findIndex(seat => direction === 'DESC' ? seat < referenceSeat : seat > referenceSeat)
  const index = startIndex >= 0 ? startIndex : 0
  return seats.slice(index).concat(seats.slice(0, index))
}
function startDay(game, room) {
  if (!game.voteHistory) game.voteHistory = (game.dayState && game.dayState.voteResults || []).map(result => ({ ...result, day: game.day }))
  const previousSeat = game.dayState && game.dayState.sheriffSeat || 0; const previousMember = room.members.find(item => item.seat === previousSeat); const previousSheriff = previousMember && game.roles[previousMember.userId].alive ? previousSeat : 0
  game.dayState = { stage: game.day === 1 && !game.sheriffElectionDone ? 'SHERIFF_SIGNUP' : 'SPEECH_ORDER', candidates: [], sheriffSeat: previousSheriff, signup: {}, sheriffVotes: {}, resultConfirmations: {}, exileVotes: {}, speechQueue: [], speakerSeat: 0, speechDeadline: 0, direction: 'ASC', resultText: '' }
  if (!(game.day === 1 && !game.firstNightRevealed)) {
    if (!beginDeathSkills(game, room, game.dayState.stage)) { const result = winner(game, room); if (result) { game.phase = 'FINISHED'; game.winner = result; room.status = 'FINISHED' } }
  }
  runDayAutomation(game, room)
}
function finishSheriffElection(game, room) {
  const election = electionFor(game, room, true)
  if (election) game.sheriffElection = { ...election, completed: true, sheriffSeat: game.dayState.sheriffSeat || 0 }
  const state = game.dayState; game.sheriffElectionDone = true
  if (game.day === 1 && !game.firstNightRevealed) { game.firstNightRevealed = true; state.stage = 'NIGHT_RESULT'; state.resultConfirmations = {}; state.resultText = game.publicResult.length ? `首夜，${game.publicResult.join('、')}号玩家离场` : '首夜是一个平安夜' }
  else state.stage = 'SPEECH_ORDER'
}
function enterNextNightOrFinish(game, room) {
  if (!game.voteHistory) game.voteHistory = (game.dayState && game.dayState.voteResults || []).map(result => ({ ...result, day: game.day }))
  const result = winner(game, room)
  if (result) { game.phase = 'FINISHED'; game.winner = result; room.status = 'FINISHED'; game.stageReadyAt = 0 }
  else {
    game.day += 1; game.phase = 'NIGHT'; game.night = {}; game.publicResult = []; game.confirmedUserIds = []
    setNightStage(game, room, 'WEREWOLF')
    runBots(game, room)
  }
}
function explodeWolf(game, room, userId, targetSeat) {
  const election = electionFor(game, room)
  const mine = game.roles[userId], me = member(room, userId)
  if (game.phase !== 'DAY' || !mine || !mine.alive || !transformationVisible(game, mine) || game.dayState && ['NIGHT_RESULT', 'DEATH_SKILL', 'EXILE_VOTE', 'COMPLETE'].includes(game.dayState.stage)) fail('FORBIDDEN', '当前不能自爆')
  if (mine.role === '白狼王') {
    const target = room.members.find(item => item.seat === Number(targetSeat))
    if (!target || target.userId === userId || !publiclyAlive(game, target)) fail('BAD_TARGET', '白狼王请选择其他存活玩家')
    killPlayer(game, room, target.seat, 'WHITE_EXPLOSION')
  }
  if (election && !election.completed) game.sheriffElection = { ...election, completed: true, interrupted: true, sheriffSeat: 0 }
  mine.abilities = mine.abilities || {}; mine.abilities.revealed = true
  recordSkill(game, `${me.seat}号${mine.role}自爆${mine.role === '白狼王' ? '，带走' + Number(targetSeat) + '号' : ''}`)
  killPlayer(game, room, me.seat, 'EXPLOSION')
  transformWildChildren(game)
  if (game.dayState && game.dayState.sheriffSeat === me.seat) game.dayState.sheriffSeat = 0
  if (game.day === 1 && !game.firstNightRevealed) {
    game.firstNightRevealed = true; game.sheriffElectionDone = true
    // Preserve only the previous night's deaths; the exploded wolf is not a night casualty.
    game.dayState = { ...game.dayState, stage: 'NIGHT_RESULT', sheriffSeat: 0, resultConfirmations: {}, nextAfterResult: 'EXPLOSION',
      resultText: game.publicResult.length ? `首夜，${game.publicResult.join('、')}号玩家离场` : '首夜是一个平安夜' }
    // Longest bundled two-casualty sequence is 3.2s, plus margin and configured interval.
    game.stageReadyAt = now() + 3500 + Math.max(1, Math.min(6, Number(room.config.interval) || 3)) * 1000
  } else enterNextNightOrFinish(game, room)
}
function resolveSignup(game, room) {
  const state = game.dayState; state.candidates = room.members.filter(item => (game.day === 1 && !game.firstNightRevealed || game.roles[item.userId].alive) && canVote(game, item) && state.signup[item.userId]).map(item => item.seat)
  if (state.candidates.length === 1) { state.sheriffSeat = state.candidates[0]; finishSheriffElection(game, room); return }
  if (!state.candidates.length) { finishSheriffElection(game, room); return }
  state.withdrawn = {}; state.speechQueue = state.candidates.slice().sort((a, b) => a - b)
  state.speakerSeat = state.speechQueue[0]; state.speechDeadline = now() + 90000; state.stage = 'SHERIFF_SPEECH'
}
function sheriffVoters(game, room) { return room.members.filter(item => publiclyAlive(game, item) && canVote(game, item) && (game.dayState.sheriffRound === 2 || !(game.dayState.signup || {})[item.userId])) }
function finishSheriffSpeeches(game, room) {
  const state = game.dayState
  state.speakerSeat = 0; state.speechDeadline = 0
  if (state.candidates.length === 1) { state.sheriffSeat = state.candidates[0]; finishSheriffElection(game, room) }
  else if (!state.candidates.length || !sheriffVoters(game, room).length) { state.sheriffSeat = 0; finishSheriffElection(game, room) }
  else { state.stage = 'SHERIFF_VOTE'; state.sheriffVotes = {} }
}
function advanceSheriffSpeech(game, room) {
  const state = game.dayState; state.speechQueue.shift()
  state.speechQueue = state.speechQueue.filter(seat => state.candidates.includes(seat))
  if (!state.speechQueue.length) { finishSheriffSpeeches(game, room); return }
  state.speakerSeat = state.speechQueue[0]; state.speechDeadline = now() + 90000
}
function canSpeak(game, me) {
  const state = game.dayState
  return !!state && state.speakerSeat === me.seat && (['SHERIFF_SPEECH', 'SHERIFF_PK_SPEECH'].includes(state.stage) ? publiclyAlive(game, me) : ['SPEECH', 'EXILE_PK_SPEECH'].includes(state.stage) && !!aliveRole(game, me.userId))
}
function resolveSheriffVote(game, room) {
  const state = game.dayState, leaders = voteLeaders(state.sheriffVotes, game, room, sheriffVoters(game, room))
  recordVoteResult(game, state.sheriffVotes, sheriffVoters(game, room), 'SHERIFF', leaders)
  if (leaders.length > 1 && state.sheriffRound !== 2) { beginPkSpeech(game, leaders, 'SHERIFF'); return }
  state.sheriffSeat = leaders.length === 1 ? leaders[0] : 0
  finishSheriffElection(game, room)
  if (leaders.length > 1) state.resultText = `${state.resultText || ''}${state.resultText ? '；' : ''}警徽流失`
}
function beginSpeech(game, room, direction) { const state = game.dayState; const owner = room.members.find(item => item.userId === room.ownerId); const referenceSeat = state.sheriffSeat || owner && owner.seat || 0; state.direction = direction; state.speechQueue = makeSpeechQueue(room, game, referenceSeat, direction); state.speakerSeat = state.speechQueue[0] || 0; state.speechDeadline = now() + 90000; state.stage = state.speakerSeat ? 'SPEECH' : 'EXILE_VOTE' }
function advanceSpeech(game) { const state = game.dayState; state.speechQueue.shift(); state.speakerSeat = state.speechQueue[0] || 0; state.speechDeadline = state.speakerSeat ? now() + 90000 : 0; if (!state.speakerSeat) state.stage = 'EXILE_VOTE' }
function resolveExileVote(game, room) {
  const state = game.dayState, eligible = room.members.filter(item => !!aliveRole(game, item.userId) && canVote(game, item))
  const leaders = voteLeaders(state.exileVotes, game, room, eligible)
  recordVoteResult(game, state.exileVotes, eligible, 'EXILE', leaders)
  if (leaders.length > 1 && state.exileRound !== 2) { beginPkSpeech(game, leaders, 'EXILE'); return }
  const seat = leaders.length === 1 ? leaders[0] : 0
  if (seat) {
    const target = room.members.find(item => item.seat === seat), role = game.roles[target.userId]
    role.abilities = role.abilities || {}
    game.lastExile = { day: game.day, seat, camp: isWolf(role) ? '狼人阵营' : '好人阵营' }
    if (role.role === '白痴' && !role.abilities.idiotRevealed) { role.abilities.idiotRevealed = true; role.abilities.revealed = true; game.lastExile = { day: game.day, seat: 0, camp: '' }; if (state.sheriffSeat === seat) state.sheriffSeat = 0; state.resultText = `${seat}号白痴翻牌免于放逐，此后不能投票`; recordSkill(game, state.resultText); state.voteResults[state.voteResults.length - 1].summary = state.resultText; game.voteHistory[game.voteHistory.length - 1].summary = state.resultText }
    else { killPlayer(game, room, seat, 'EXILE'); state.resultText = `${seat}号被放逐出局` }
  } else { game.lastExile = { day: game.day, seat: 0, camp: '' }; state.resultText = leaders.length ? '再次平票，本轮无人出局' : '无人得票，本轮无人出局' }
  transformWildChildren(game)
  state.stage = 'COMPLETE'; state.nightConfirmations = {}; beginDeathSkills(game, room, 'COMPLETE')
}
function runDayAutomation(game, room) {
  if (game.phase !== 'DAY' || !game.dayState) return
  for (let loop = 0; loop < 20; loop += 1) {
    const state = game.dayState; const alive = room.members.filter(item => game.day === 1 && !game.firstNightRevealed || game.roles[item.userId].alive)
    if (state.stage === 'DEATH_SKILL') {
      const actor = room.members.find(item => item.seat === state.shooterSeat)
      if (actor && (actor.isBot || now() >= state.speechDeadline)) { shoot(game, room, actor.userId, 0); if (game.phase !== 'DAY') return; continue }
      return
    }
    if (state.stage === 'NIGHT_RESULT' && state.nextAfterResult === 'EXPLOSION') {
      if (now() < game.stageReadyAt) return
      if (beginDeathSkills(game, room, 'NEXT_NIGHT')) continue
      enterNextNightOrFinish(game, room); return
    }
    if (state.stage === 'COMPLETE') {
      const required = confirmationMembers(game, room)
      state.nightConfirmations = state.nightConfirmations || {}
      required.filter(item => item.isBot).forEach(item => { state.nightConfirmations[item.userId] = true })
      if (required.every(item => state.nightConfirmations[item.userId])) enterNextNightOrFinish(game, room)
      return
    }
    if (state.stage === 'SHERIFF_SIGNUP') { alive.filter(item => item.isBot).forEach(item => { if (!Object.prototype.hasOwnProperty.call(state.signup, item.userId)) state.signup[item.userId] = crypto.randomInt(2) === 1 }); if (Object.keys(state.signup).length === alive.length) { resolveSignup(game, room); continue } return }
    if (state.stage === 'SHERIFF_SPEECH') { const speaker = room.members.find(item => item.seat === state.speakerSeat); if ((speaker && speaker.isBot) || now() >= state.speechDeadline) { advanceSheriffSpeech(game, room); continue } return }
    if (['SHERIFF_PK_SPEECH', 'EXILE_PK_SPEECH'].includes(state.stage)) { const speaker = room.members.find(item => item.seat === state.speakerSeat); if ((speaker && speaker.isBot) || now() >= state.speechDeadline) { advancePkSpeech(game); continue } return }
    if (state.stage === 'SHERIFF_VOTE') { const voters = sheriffVoters(game, room); voters.filter(item => item.isBot).forEach(item => { if (!Object.prototype.hasOwnProperty.call(state.sheriffVotes, item.userId)) state.sheriffVotes[item.userId] = randomItem(state.candidates) || 0 }); if (voters.every(item => Object.prototype.hasOwnProperty.call(state.sheriffVotes, item.userId))) { state.sheriffVotes = Object.fromEntries(voters.map(item => [item.userId, state.sheriffVotes[item.userId]])); resolveSheriffVote(game, room); continue } return }
    if (state.stage === 'NIGHT_RESULT') { const required = confirmationMembers(game, room); required.filter(item => item.isBot).forEach(item => { state.resultConfirmations[item.userId] = true }); if (required.every(item => state.resultConfirmations[item.userId])) { state.stage = 'SPEECH_ORDER'; state.resultText = ''; if (!beginDeathSkills(game, room, 'SPEECH_ORDER')) { const result = winner(game, room); if (result) { game.phase = 'FINISHED'; game.winner = result; room.status = 'FINISHED'; return } } continue } return }
    if (state.stage === 'SPEECH_ORDER') { const sheriff = room.members.find(item => item.seat === state.sheriffSeat); if (sheriff && sheriff.isBot) { beginSpeech(game, room, crypto.randomInt(2) ? 'ASC' : 'DESC'); continue } return }
    if (state.stage === 'SPEECH') { const speaker = room.members.find(item => item.seat === state.speakerSeat); if ((speaker && speaker.isBot) || now() >= state.speechDeadline) { advanceSpeech(game); continue } return }
    if (state.stage === 'EXILE_VOTE') { const voters = alive.filter(item => canVote(game, item)); voters.filter(item => item.isBot).forEach(item => { if (!Object.prototype.hasOwnProperty.call(state.exileVotes, item.userId)) { const options = alive.filter(target => !(game.roles[target.userId].abilities || {}).idiotRevealed && (state.exileRound !== 2 || (state.pkCandidates || []).includes(target.seat))); const target = randomItem(options); state.exileVotes[item.userId] = target ? target.seat : 0 } }); if (voters.every(item => Object.prototype.hasOwnProperty.call(state.exileVotes, item.userId))) { resolveExileVote(game, room); continue } return }
    return
  }
}

function randomItem(values) { return values.length ? values[crypto.randomInt(values.length)] : null }
function resolveWolfVote(game, room) {
  const wolves = room.members.filter(item => game.roles[item.userId].alive && isWolf(game.roles[item.userId]))
  const actions = wolves.map(item => game.actions[phaseKey(game) + ':' + item.userId]).filter(Boolean)
  if (actions.length !== wolves.length) return false
  const counts = {}; actions.forEach(item => { counts[item.targetSeat] = (counts[item.targetSeat] || 0) + 1 })
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (top && Number(top[1]) > wolves.length / 2) { game.night.attackedSeat = Number(top[0]); nextStage(game, room); return true }
  // Keep split votes visible; wolves can revise their choices until consensus is reached.
  return false
}
function suggestWolfTarget(game, room, userId, seat) {
  const mine = aliveRole(game, userId)
  if (!mine || !isWolf(mine)) fail('FORBIDDEN', '只有存活狼人可以建议袭击目标')
  if (game.phase !== 'NIGHT' || game.nightStage !== 'WEREWOLF' || game.night.cue !== 'ACTION') fail('WRONG_PHASE', '当前不是狼人行动阶段')
  if (game.stageReadyAt && now() < game.stageReadyAt) fail('ANNOUNCEMENT_PLAYING', '请等待本阶段播报结束')
  const target = room.members.find(item => item.seat === Number(seat))
  if (!target || !game.roles[target.userId].alive) fail('BAD_TARGET', '请选择存活玩家')
  game.night.wolfSuggestions = game.night.wolfSuggestions || {}
  game.night.wolfSuggestions[userId] = target.seat
}
function runBots(game, room) {
  for (let loop = 0; loop < 20; loop += 1) {
    if (game.phase === 'ROLE_REVEAL') {
      const required = confirmationMembers(game, room)
      required.filter(item => item.isBot).forEach(item => { item.roleConfirmed = true; if (!game.confirmedUserIds.includes(item.userId)) game.confirmedUserIds.push(item.userId) })
      if (!required.every(item => game.confirmedUserIds.includes(item.userId))) return
      game.phase = 'NIGHT'; game.night = {}; setNightStage(game, room, Object.values(game.roles).some(role => role.role === '野孩子') ? 'WILD_CHILD' : 'WEREWOLF'); game.confirmedUserIds = []; return
    }
    if (game.phase === 'DAWN') {
      const required = confirmationMembers(game, room)
      required.filter(item => item.isBot).forEach(item => { if (!game.confirmedUserIds.includes(item.userId)) game.confirmedUserIds.push(item.userId) })
      if (required.every(item => game.confirmedUserIds.includes(item.userId))) { game.phase = 'DAY'; game.confirmedUserIds = [] }
      return
    }
    if (game.phase !== 'NIGHT') return
    if (game.stageReadyAt && now() < game.stageReadyAt) return
    if (game.night.cue === 'START') { setNightCue(game, room, 'OPEN'); return }
    if (game.night.cue === 'OPEN') { setNightCue(game, room, 'ACTION'); return }
    if (game.night.cue === 'CLOSE') { if (nextStage(game, room)) resolveNight(game, room); return }
    const stageRole = { WILD_CHILD: '野孩子', WEREWOLF: '狼人', SEER: '预言家', WITCH: '女巫', GUARD: '守卫', GRAVEKEEPER: '守墓人' }[game.nightStage]
    if (stageRole && !Object.values(game.roles).some(item => (stageRole === '狼人' ? isWolf(item) : item.role === stageRole) && item.alive)) {
      // A departed role keeps its public cue sequence; no action or medicine is fabricated.
      nextStage(game, room); return
    }
    if (game.nightStage === 'WEREWOLF') {
      const wolves = room.members.filter(item => game.roles[item.userId].alive && isWolf(game.roles[item.userId]))
      const targets = room.members.filter(item => game.roles[item.userId].alive)
      const existing = wolves.map(item => game.actions[phaseKey(game) + ':' + item.userId]).find(Boolean)
      const sharedTarget = existing ? room.members.find(value => value.seat === existing.targetSeat) : randomItem(targets)
      wolves.filter(item => item.isBot && !game.actions[phaseKey(game) + ':' + item.userId]).forEach(item => { if (sharedTarget) game.actions[phaseKey(game) + ':' + item.userId] = { targetSeat: sharedTarget.seat } })
      if (resolveWolfVote(game, room)) continue
      return
    }
    if (game.nightStage === 'WILD_CHILD') {
      const actor = room.members.find(item => game.roles[item.userId].role === '野孩子' && game.roles[item.userId].alive)
      if (!actor || !actor.isBot) return
      const mine = game.roles[actor.userId]
      const target = room.members.find(item => item.userId === mine.modelUserId) || randomItem(room.members.filter(item => item.userId !== actor.userId && game.roles[item.userId].alive))
      if (target) { mine.modelUserId = target.userId; game.actions[phaseKey(game) + ':' + actor.userId] = { targetSeat: target.seat }; nextStage(game, room) }
      return
    }
    if (game.nightStage === 'GRAVEKEEPER') {
      const actor = room.members.find(item => game.roles[item.userId].role === '守墓人' && game.roles[item.userId].alive)
      if (actor && actor.isBot) { game.actions[phaseKey(game) + ':' + actor.userId] = { confirmed: true }; nextStage(game, room) }
      return
    }
    const roleName = { SEER: '预言家', WITCH: '女巫', GUARD: '守卫', GRAVEKEEPER: '守墓人' }[game.nightStage]
    const actor = room.members.find(item => item.isBot && game.roles[item.userId].alive && game.roles[item.userId].role === roleName)
    if (!actor) return
    const mine = game.roles[actor.userId]; const key = phaseKey(game) + ':' + actor.userId; const aliveTargets = room.members.filter(item => game.roles[item.userId].alive)
    if (game.nightStage === 'SEER') { const target = randomItem(aliveTargets.filter(item => item.userId !== actor.userId)); if (target) game.actions[key] = { targetSeat: target.seat, result: isWolf(game.roles[target.userId]) ? '狼人阵营' : '好人阵营' } }
    if (game.nightStage === 'WITCH') { const useSave = !!game.night.attackedSeat && mine.abilities.antidote && crypto.randomInt(2) === 1; const poisonTarget = !useSave && mine.abilities.poison && crypto.randomInt(3) === 0 ? randomItem(aliveTargets.filter(item => item.seat !== game.night.attackedSeat)) : null; if (useSave) { mine.abilities.antidote = false; game.night.saved = true } if (poisonTarget) { mine.abilities.poison = false; game.night.poisonedSeat = poisonTarget.seat } game.actions[key] = { useSave, poisonSeat: poisonTarget ? poisonTarget.seat : 0 } }
    if (game.nightStage === 'GUARD') { const target = randomItem(aliveTargets.filter(item => item.seat !== mine.abilities.lastGuardedSeat)); if (target) { mine.abilities.lastGuardedSeat = target.seat; game.night.guardedSeat = target.seat; game.actions[key] = { targetSeat: target.seat } } }
    nextStage(game, room); if (game.nightStage === 'RESOLVE') resolveNight(game, room)
  }
}

  return { killPlayer, beginDeathSkills, shoot, duel, canVote, setNightCue, setNightStage, nextStage, resolveNight, winner, voteLeaders, recordVoteResult, beginPkSpeech, advancePkSpeech, makeSpeechQueue, startDay, finishSheriffElection, enterNextNightOrFinish, explodeWolf, resolveSignup, sheriffVoters, finishSheriffSpeeches, advanceSheriffSpeech, canSpeak, resolveSheriffVote, beginSpeech, advanceSpeech, resolveExileVote, runDayAutomation, randomItem, resolveWolfVote, suggestWolfTarget, runBots }
}
module.exports = { createGameRules }
