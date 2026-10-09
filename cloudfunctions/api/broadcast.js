const { runInTransaction } = require('./repository')
function createBroadcast({ db, now, fail, getGame, member, assertMember, signalRecipients, publishSignals }) {
const BROADCAST_LEASE_MS = 10000
function broadcaster(room) {
  const selected = member(room, room.broadcasterUserId)
  return selected && !selected.isBot ? selected.userId : room.ownerId
}
function broadcastView(room) {
  const userId = broadcaster(room)
  const player = member(room, userId)
  return { userId, nickname: player ? player.nickname : '', version: room.broadcastVersion || 0, online: room.broadcastSessionUserId === userId && Number(room.broadcastExpiresAt || 0) > now() }
}
async function updateBroadcast(roomId, userId, action, payload, store = db) {
  const db = store
  return runInTransaction(db, async transaction => {
    const ref = transaction.collection('rooms').doc(roomId)
    const room = (await ref.get()).data
    assertMember(room, userId)
    const current = broadcaster(room)
    const timestamp = now()
    if (action === 'transferBroadcast') {
      if (room.ownerId !== userId) fail('FORBIDDEN', '只有房主可以转交播报权')
      if (Number(payload.broadcastVersion) !== Number(room.broadcastVersion || 0)) fail('STALE_STATE', '播报设备已更新，请重试')
      const target = member(room, String(payload.userId || ''))
      if (!target || target.isBot) fail('BAD_TARGET', '请选择房内真人玩家')
      const recipients = await signalRecipients(transaction, room.members)
      const change = { broadcasterUserId: target.userId, broadcastVersion: (room.broadcastVersion || 0) + 1, broadcastAvailableAt: Math.max(timestamp, Number(room.broadcastExpiresAt || 0)), broadcastExpiresAt: 0, broadcastSession: '', broadcastSessionUserId: '' }
      await ref.update({ data: change })
      await publishSignals(transaction, { ...room, ...change }, recipients)
      return { granted: false, leaseMs: 0 }
    }
    const sessionId = String(payload.sessionId || '')
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(sessionId)) fail('BAD_SESSION', '播报设备标识无效')
    const owns = room.broadcastSession === sessionId && room.broadcastSessionUserId === userId
    if (action === 'releaseBroadcast') {
      if (owns) {
        const change = { broadcastExpiresAt: 0, broadcastSession: '', broadcastSessionUserId: '' }
        await ref.update({ data: change })
        await publishSignals(transaction, { ...room, ...change }, await signalRecipients(transaction, room.members))
      }
      return { granted: false, leaseMs: 0 }
    }
    if (current !== userId || timestamp < Number(room.broadcastAvailableAt || 0) || (!owns && timestamp < Number(room.broadcastExpiresAt || 0))) return { granted: false, leaseMs: 0 }
    await ref.update({ data: { broadcastSession: sessionId, broadcastSessionUserId: userId, broadcastExpiresAt: timestamp + BROADCAST_LEASE_MS } })
    if (!owns || Number(room.broadcastExpiresAt || 0) <= timestamp) {
      await publishSignals(transaction, { ...room, broadcastSession: sessionId, broadcastSessionUserId: userId, broadcastExpiresAt: timestamp + BROADCAST_LEASE_MS }, await signalRecipients(transaction, room.members))
    } else if (transaction.isTransaction) {
      const taskRef = transaction.collection('game_tasks').doc(roomId)
      const task = (await taskRef.get()).data
      // An overdue stage must run before the lease can be renewed again.
      // Keeping only future deadlines lets heartbeats indefinitely starve the worker.
      let stageDueAt = task && Number(task.stageDueAt) > 0 ? Number(task.stageDueAt) : 0
      if (!stageDueAt && room.gameId && getGame) {
        const game = await getGame(room, transaction)
        // Repair legacy tasks that already lost the deadline. Human ACTION
        // stages wait for input and must not acquire a recurring expired task.
        if (game && game.phase === 'NIGHT' && ['START', 'OPEN', 'CLOSE'].includes((game.night || {}).cue)) stageDueAt = Number(game.stageReadyAt || 0)
        else if (game && game.phase === 'DAY' && game.dayState) stageDueAt = game.dayState.nextAfterResult === 'EXPLOSION' ? Number(game.stageReadyAt || 0) : Number(game.dayState.speechDeadline || 0)
      }
      const dueAt = stageDueAt ? Math.min(stageDueAt, timestamp + BROADCAST_LEASE_MS) : timestamp + BROADCAST_LEASE_MS
      await taskRef.set({ data: { roomId, gameId: room.gameId || '', version: room.version, dueAt, stageDueAt } })
    }
    return { granted: true, leaseMs: BROADCAST_LEASE_MS, version: room.broadcastVersion || 0 }
  })
}

return { broadcaster, broadcastView, updateBroadcast }
}
module.exports = { createBroadcast }
