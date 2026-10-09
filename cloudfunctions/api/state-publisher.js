const crypto = require('crypto')
const clean = value => JSON.parse(JSON.stringify(value))
const personalGame = ['myRole', 'myAction', 'myConfirmed', 'confirmationRequired', 'waiting']
const personalDay = ['myVoteWeight', 'submitted', 'canChooseOrder', 'canFinishSpeech', 'canSheriffVote', 'canWithdraw', 'speechExtensionsRemaining', 'canExplode', 'canExileVote', 'canDuel']
const publicGame = ['id', 'phase', 'stageReadyAt', 'nightStage', 'nightCue', 'day', 'version', 'confirmedCount', 'totalCount', 'resultPending', 'publicResult', 'winner', 'voteHistory', 'skillHistory', 'sheriffElection']
const publicDay = ['stage', 'voteResults', 'voteRound', 'pkCandidates', 'candidates', 'sheriffSeat', 'speakerSeat', 'speechDeadline', 'direction', 'resultText', 'withdrawnSeats', 'nextAfterResult', 'targets', 'shooterSeat']
const pick = (value, fields) => Object.fromEntries(fields.filter(key => key in value).map(key => [key, value[key]]))
function splitView(view) {
  // Explicit allowlists keep newly added secret fields private by default.
  const source = clean(view)
  const publicView = pick(source, ['id', 'code', 'ownerId', 'status', 'broadcast', 'config', 'version', 'members'])
  const privateView = { game: {} }
  if (source.game) {
    publicView.game = pick(source.game, publicGame)
    privateView.game = pick(source.game, personalGame)
    if (source.game.dayView) {
      publicView.game.dayView = pick(source.game.dayView, publicDay)
      privateView.game.dayView = pick(source.game.dayView, personalDay)
    }
  }
  return { publicView, privateView }
}
async function publishState(store, room, game, recipients, project, timestamp = Date.now()) {
  const members = room.members.filter(item => !item.isBot)
  const previous = room.subscriptionMeta || {}, revision = Number(previous.revision || 0) + 1
  const hashes = {}, privateVersions = {}, readers = []
  let publicView = null
  for (const item of members) {
    const recipient = recipients.find(value => value.userId === item.userId)
    if (!recipient) throw new Error('Missing subscription recipient')
    const owner = recipient.authOpenid || recipient.openid
    if (!readers.includes(owner)) readers.push(owner)
    const split = splitView(project(room, game, item.userId))
    publicView = publicView || split.publicView
    const hash = crypto.createHash('sha256').update(JSON.stringify(split.privateView)).digest('hex')
    hashes[item.userId] = hash
    privateVersions[item.userId] = previous.hashes && previous.hashes[item.userId] === hash ? previous.privateVersions[item.userId] : revision
    const virtual = recipient.openid.startsWith('virtual:')
    if (virtual || privateVersions[item.userId] === revision) {
      await store.collection('room_signals').doc(item.userId).set({ data: {
        _openid: owner, roomId: room._id, version: room.version, broadcastVersion: room.broadcastVersion || 0,
        protocol: virtual ? 1 : 2, revision: privateVersions[item.userId],
        // Simulator slots share one real credential. Never publish their secrets to it.
        ...(virtual ? {} : { state: split.privateView }),
      } })
    }
  }
  for (const item of recipients.filter(value => !members.some(member => member.userId === value.userId))) {
    await store.collection('room_signals').doc(item.userId).set({ data: { _openid: item.authOpenid || item.openid, roomId: '', version: room.version, broadcastVersion: room.broadcastVersion || 0, protocol: 2, revision, state: null } })
  }
  const ref = store.collection('room_states').doc(room._id)
  if (publicView) {
    await ref.set({ data: { roomId: room._id, readers, revision, privateVersions, publishedAt: timestamp, state: publicView } })
    await store.collection('rooms').doc(room._id).update({ data: { subscriptionMeta: store.command.set({ revision, hashes, privateVersions }) } })
  } else await ref.remove()
  const stageDeadline = game && (game.phase === 'NIGHT' || game.dayState && game.dayState.nextAfterResult === 'EXPLOSION'
    ? game.stageReadyAt : game.phase === 'DAY' && game.dayState ? game.dayState.speechDeadline : 0)
  const deadlines = [stageDeadline, room.broadcastExpiresAt].filter(value => value > timestamp)
  const deadline = deadlines.length ? Math.min(...deadlines) : 0
  const task = store.collection('game_tasks').doc(room._id)
  if (deadline) await task.set({ data: { roomId: room._id, gameId: room.gameId || '', version: room.version, dueAt: deadline, stageDueAt: stageDeadline > timestamp ? stageDeadline : 0 } })
  else await task.remove()
}
module.exports = { splitView, publishState }
