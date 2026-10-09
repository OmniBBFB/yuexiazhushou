const { electionFor } = require('./sheriff-record')
const { isWolf, faction, transformationVisible } = require('./role-state')
const roleDescriptions = {
  '狼人': '与狼队友共同选择一名玩家袭击。隐藏身份，活到最后。',
  '预言家': '每晚查验一名玩家的阵营，帮助好人找出狼人。',
  '女巫': '拥有一瓶解药和一瓶毒药，每瓶整局只能使用一次，同一晚最多使用一种。',
  '猎人': '被狼刀、放逐或开枪带走时，可开枪带走一名存活玩家，也可放弃；被毒或白狼王带走时不能开枪。',
  '白痴': '被放逐时翻牌存活，此后失去投票权、不能再被放逐，仍可发言；其他死亡方式不能免死。',
  '守墓人': '每晚获知上一轮白天被放逐玩家的阵营，结果仅自己可见。',
  '骑士': '警长竞选后、放逐投票前可进行一次决斗：目标为狼则目标出局并进入夜晚，否则自己出局。',
  '白狼王': '与狼队共同袭击；白天自爆时必须选择另一名存活玩家一同出局，被带走者不能开枪。',
  '狼王': '与狼队共同袭击；被狼刀、放逐或开枪带走时可开枪，被毒、决斗或自爆时不能开枪。',
  '守卫': '每晚守护一名玩家，不能连续两晚守护同一人。',
  '村民': '观察发言与行为，和好人一起找出狼人。',
  '野孩子': '首夜选择一名榜样；榜样被淘汰后转为狼人，从下一夜加入狼队。',
}
function createProjection({ now, assertMember, broadcastView, publiclyAlive, confirmationMembers, phaseKey, sheriffVoters, canSpeak }) {
function project(room, game, userId) {
  const me = assertMember(room, userId)
  const view = {
    id: room._id, code: room.code, ownerId: room.ownerId, status: room.status, broadcast: broadcastView(room),
    config: { ...room.config, password: undefined }, version: room.version,
    members: room.members.map(item => ({ userId: item.userId, nickname: item.nickname, seat: item.seat || 0, ready: !!item.ready, alive: game ? publiclyAlive(game, item) : item.alive !== false, online: true, roleConfirmed: !!item.roleConfirmed, isOwner: item.userId === room.ownerId, isBot: !!item.isBot, finalCamp: game && game.phase === 'FINISHED' && game.roles[item.userId] ? faction(game.roles[item.userId]) : undefined, revealedRole: game && game.roles[item.userId] && (game.roles[item.userId].abilities || {}).revealed ? game.roles[item.userId].role : undefined, finalRole: game && game.phase === 'FINISHED' && game.roles[item.userId] ? game.roles[item.userId].role : undefined })),
  }
  if (!game) return view
  const mine = game.roles[userId]
  const required = confirmationMembers(game, room)
  const confirmationRequired = required.some(item => item.userId === userId)
  const resultPending = game.day === 1 && !game.firstNightRevealed
  const gameView = { skillHistory: game.skillHistory || [], id: game._id, phase: game.phase, stageReadyAt: game.stageReadyAt || 0, serverTime: now(), nightStage: game.phase === 'NIGHT' ? game.nightStage : '', day: game.day, version: room.version, waiting: true, confirmedCount: required.filter(item => game.confirmedUserIds.includes(item.userId)).length, totalCount: required.length, confirmationRequired, myConfirmed: !confirmationRequired || game.confirmedUserIds.includes(userId), resultPending, publicResult: resultPending ? [] : (game.publicResult || []), winner: game.winner || '' }
  if (game.phase !== 'WAITING' && mine) gameView.myRole = { role: mine.role, description: mine.role === '野孩子' && transformationVisible(game, mine) ? '已转为狼人，与狼队共同袭击，跟随狼人阵营获胜。' : roleDescriptions[mine.role], confirmed: !!me.roleConfirmed, ...(mine.role === '守墓人' && mine.abilities.graveResult ? { graveResult: mine.abilities.graveResult } : {}), ...(mine.role === '野孩子' ? { transformed: transformationVisible(game, mine), modelSeat: (room.members.find(item => item.userId === mine.modelUserId) || {}).seat || 0 } : {}) }
  // History consists only of completed, public rounds. Older games can expose
  // the current day's completed rounds even before a history field exists.
  gameView.voteHistory = (game.voteHistory || (game.dayState && game.dayState.voteResults || []).map(result => ({ ...result, day: game.day }))).map(result => ({
    day: result.day, kind: result.kind, round: result.round, summary: result.summary,
    totals: (result.totals || []).map(total => ({ seat: total.seat, votes: total.votes, voterSeats: total.voterSeats, sheriffVoterSeats: total.sheriffVoterSeats })),
    abstainedSeats: result.abstainedSeats || [],
  }))
  gameView.sheriffElection = electionFor(game, room)
  gameView.nightCue = game.phase === 'NIGHT' ? (game.night.cue || 'ACTION') : ''
  if (game.phase === 'NIGHT' && mine && mine.alive && gameView.nightCue === 'ACTION') {
    const roleStage = isWolf(mine) ? 'WEREWOLF' : { '野孩子': 'WILD_CHILD', '狼人': 'WEREWOLF', '预言家': 'SEER', '女巫': 'WITCH', '守卫': 'GUARD', '守墓人': 'GRAVEKEEPER' }[mine.role]
    if (roleStage === game.nightStage) {
      const targets = room.members.map(item => ({ seat: item.seat, nickname: item.nickname, alive: game.roles[item.userId].alive })).filter(item => item.alive && (!['预言家', '野孩子'].includes(mine.role) || isWolf(mine) || item.seat !== me.seat))
      const action = { type: game.nightStage, targets, submitted: !!game.actions[phaseKey(game) + ':' + userId] }
      if (isWolf(mine)) {
        const wolves = room.members.filter(item => transformationVisible(game, game.roles[item.userId]))
        action.teammates = wolves.map(item => item.seat)
        action.wolfTeam = wolves.map(item => ({ seat: item.seat, nickname: item.nickname, alive: game.roles[item.userId].alive,
          suggestedSeat: (game.night.wolfSuggestions || {})[item.userId] || 0,
          selectedSeat: (game.actions[phaseKey(game) + ':' + item.userId] || {}).targetSeat || 0 }))
      }
      if (mine.role === '守墓人') { const result = mine.abilities.graveResult; action.targets = []; action.result = result && result.seat ? `${result.seat}号：${result.camp}` : '上一轮没有玩家被放逐' }
      if (mine.role === '女巫') { action.attackedSeat = game.night.attackedSeat || 0; action.canSave = mine.abilities.antidote; action.canPoison = mine.abilities.poison }
      const ownAction = game.actions[phaseKey(game) + ':' + userId]
      if (mine.role === '预言家' && ownAction && ownAction.result) action.result = ownAction.result
      gameView.myAction = action; gameView.waiting = false
    }
  }
  if (game.phase === 'DAY' && game.dayState) {
    const canVote = !!mine && mine.alive && !(mine.abilities || {}).idiotRevealed
    const canDuel = !!mine && mine.alive && mine.role === '骑士' && !(mine.abilities || {}).duelUsed && ['SPEECH_ORDER', 'SPEECH'].includes(game.dayState.stage)
    const canShoot = game.dayState.stage === 'DEATH_SKILL' && game.dayState.shooterSeat === me.seat && !!(mine.abilities || {}).shotPending
    if (canShoot) { gameView.myAction = { type: 'SHOOT', targets: room.members.filter(item => game.roles[item.userId].alive).map(item => ({ seat: item.seat, nickname: item.nickname, alive: true })), submitted: false }; gameView.waiting = false }

    const state = game.dayState; const key = state.stage === 'SHERIFF_SIGNUP' ? 'signup' : state.stage === 'SHERIFF_VOTE' ? 'sheriffVotes' : state.stage === 'NIGHT_RESULT' ? 'resultConfirmations' : state.stage === 'EXILE_VOTE' ? 'exileVotes' : state.stage === 'COMPLETE' ? 'nightConfirmations' : ''
    const electionPending = game.day === 1 && !game.firstNightRevealed
    const targets = room.members.filter(item => (electionPending || game.roles[item.userId].alive) && (state.stage !== 'SHERIFF_VOTE' || state.candidates.includes(item.seat)) && (state.stage !== 'EXILE_VOTE' || !(game.roles[item.userId].abilities || {}).idiotRevealed) && (state.stage !== 'EXILE_VOTE' || state.exileRound !== 2 || (state.pkCandidates || []).includes(item.seat))).map(item => ({ seat: item.seat, nickname: item.nickname, alive: true }))
    gameView.dayView = { canExileVote: canVote, canDuel, shooterSeat: state.shooterSeat || 0, stage: state.stage, voteResults: state.voteResults || [], voteRound: state.stage.startsWith('SHERIFF') ? state.sheriffRound || 1 : state.exileRound || 1, pkCandidates: state.pkCandidates || [], myVoteWeight: me.seat === state.sheriffSeat ? 1.5 : 1, candidates: state.candidates || [], sheriffSeat: state.sheriffSeat || 0, speakerSeat: state.speakerSeat || 0, speechDeadline: state.speechDeadline || 0, direction: state.direction || 'ASC', submitted: ['NIGHT_RESULT', 'COMPLETE'].includes(state.stage) && !confirmationRequired ? true : key ? Object.prototype.hasOwnProperty.call(state[key] || {}, userId) : false, resultText: state.resultText || '', canChooseOrder: (state.sheriffSeat ? room.members.find(item => item.seat === state.sheriffSeat).userId === userId : room.ownerId === userId), canFinishSpeech: canSpeak(game, me), canSheriffVote: sheriffVoters(game, room).some(item => item.userId === userId), canWithdraw: state.stage === 'SHERIFF_SPEECH' && !!(state.signup || {})[userId] && state.candidates.includes(me.seat), withdrawnSeats: room.members.filter(item => (state.withdrawn || {})[item.userId]).map(item => item.seat), speechExtensionsRemaining: Math.max(0, 2 - ((game.speechExtensions || {})[userId] || 0)), canExplode: !!mine && mine.alive && transformationVisible(game, mine) && !['NIGHT_RESULT', 'DEATH_SKILL', 'EXILE_VOTE', 'COMPLETE'].includes(state.stage), nextAfterResult: state.nextAfterResult || '', targets }
  }
  view.game = gameView
  return view
}

return project
}
module.exports = { createProjection }
