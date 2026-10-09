// Administrative tools only; never exposed through the client action gateway.
const { noteId } = require('./notes')
const { transactionStore, runInTransaction } = require('./repository')
async function readAll(db, collection, query = {}) {
  const rows = []
  for (let offset = 0; ; offset += 100) {
    const page = await db.collection(collection).where(query).skip(offset).limit(100).get()
    rows.push(...page.data)
    if (page.data.length < 100) return rows
  }
}
function duplicates(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const value = key(row)
    if (!groups.has(value)) groups.set(value, [])
    groups.get(value).push(row._id)
  }
  return [...groups.values()].filter(ids => ids.length > 1)
}
async function inspect(db) {
  const users = await readAll(db, 'users'), rooms = await readAll(db, 'rooms'), notes = await readAll(db, 'notes')
  return {
    counts: { users: users.length, rooms: rooms.length, notes: notes.length },
    duplicateUsers: duplicates(users, user => user.openid),
    duplicateCodes: duplicates(rooms, room => room.code),
    duplicateNotes: duplicates(notes, note => JSON.stringify([note.gameId, note.ownerId, note.targetSeat])),
    orphanUserIds: users.filter(user => user.currentRoomId && !rooms.some(room => room._id === user.currentRoomId && room.members.some(member => member.userId === user._id))).map(user => user._id),
  }
}
async function migrate(db) {
  const report = await inspect(db)
  if (report.duplicateUsers.length || report.duplicateCodes.length) throw new Error('存在重复身份或房间号，请先检查审计报告；本工具不会自动删除或合并这些数据')
  let claims = 0, notes = 0
  for (const room of await readAll(db, 'rooms')) {
    await runInTransaction(db, async transaction => {
      const current = (await transaction.collection('rooms').doc(room._id).get()).data
      if (!current) return
      const ref = transaction.collection('room_codes').doc(current.code), claim = (await ref.get()).data
      if (claim && claim.roomId !== current._id) throw new Error('房间号占用冲突')
      if (!claim) await ref.set({ data: { roomId: current._id } })
    })
    claims++
  }
  const groups = new Map()
  for (const note of await readAll(db, 'notes')) {
    const id = noteId(note.gameId, note.ownerId, note.targetSeat)
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(note)
  }
  for (const [id, legacy] of groups) {
    await db.runTransaction(async transaction => {
      const store = transactionStore(transaction, db), ref = store.collection('notes').doc(id)
      if ((await ref.get()).data) return
      const candidates = []
      for (const note of legacy) {
        const current = (await store.collection('notes').doc(note._id).get()).data
        if (current) candidates.push(current)
      }
      candidates.sort((a, b) => Number(new Date(b.updatedAt || 0)) - Number(new Date(a.updatedAt || 0)) || a._id.localeCompare(b._id))
      if (!candidates.length) return
      await ref.set({ data: { ...candidates[0], revision: 0 } })
      await store.flush()
    })
    notes++
  }
  // Leave original IDs intact for rollback and manual duplicate review.
  return { claims, notes }
}
async function cleanup(db) {
  let cleaned = 0
  for (const task of await readAll(db, 'cleanup_tasks')) {
    if ((await db.collection('rooms').where({ gameId: task.gameId }).limit(1).get()).data.length) continue
    try {
      const notes = await readAll(db, 'notes', { gameId: task.gameId })
      for (const note of notes) await db.collection('notes').doc(note._id).remove()
      await db.collection('games').doc(task.gameId).remove()
      await db.collection('cleanup_tasks').doc(task._id).remove()
      cleaned++
    } catch (_) { /* Leave the durable task for the next run. */ }
  }
  const expired = await readAll(db, 'command_receipts', { expiresAt: db.command.lt(new Date()) })
  for (const receipt of expired) await db.collection('command_receipts').doc(receipt._id).remove()
  return { cleaned, expiredReceipts: expired.length }
}
module.exports = { inspect, migrate, cleanup }
