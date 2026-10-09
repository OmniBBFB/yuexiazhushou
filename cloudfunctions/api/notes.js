const crypto = require('crypto')
const { normalizeNote, noteView } = require('./note-format')
const noteId = (gameId, ownerId, seat) => crypto.createHash('sha256').update(JSON.stringify([gameId, ownerId, seat])).digest('hex')
const error = (code, message) => { throw Object.assign(new Error(message), { code }) }
async function listNotes(db, ownerId, gameId) {
  const found = await db.collection('notes').where({ gameId, ownerId }).limit(100).get()
  // Canonical records take precedence over legacy IDs. For legacy duplicates,
  // choose the newest record deterministically and leave deletion to migration.
  const rows = new Map()
  for (const note of found.data) {
    const previous = rows.get(note.targetSeat)
    const canonical = note._id === noteId(gameId, ownerId, note.targetSeat)
    const previousCanonical = previous && previous._id === noteId(gameId, ownerId, note.targetSeat)
    if (!previous || canonical || !previousCanonical && Number(new Date(note.updatedAt || 0)) > Number(new Date(previous.updatedAt || 0))) rows.set(note.targetSeat, note)
  }
  return [...rows.values()].map(noteView)
}
async function saveNotes(store, user, room, game, payload, action) {
  if (payload.gameId && payload.gameId !== game._id) error('STALE_GAME', '对局已切换，请重新打开笔记')
  const input = action === 'saveNote' ? [payload.note || {}] : payload.notes
  if (!Array.isArray(input) || !input.length || input.length > 18) error('BAD_NOTES', '每次只能保存 1–18 条笔记')
  const seats = new Set(), pending = []
  for (const raw of input) {
    const note = normalizeNote(raw, room.members)
    if (seats.has(note.targetSeat)) error('BAD_NOTES', '同一批次不能重复保存同一座位')
    seats.add(note.targetSeat)
    const ref = store.collection('notes').doc(noteId(game._id, user._id, note.targetSeat))
    const previous = (await ref.get()).data
    const revision = previous ? Number(previous.revision || 0) : 0
    // Legacy clients remain accepted; upgraded clients use compare-and-set.
    if (raw.revision !== undefined && (!Number.isInteger(raw.revision) || raw.revision !== revision)) error('NOTE_CONFLICT', '笔记已在其他设备修改，草稿已保留，请重新加载后处理')
    const data = { ...note, _openid: user.testScope ? '' : user.openid, gameId: game._id, ownerId: user._id, revision: revision + 1, updatedAt: store.serverDate() }
    pending.push({ ref, data })
  }
  for (const item of pending) await item.ref.set({ data: item.data })
  const result = pending.map(item => noteView(item.data))
  return action === 'saveNote' ? result[0] : result
}
module.exports = { noteId, listNotes, saveNotes }
