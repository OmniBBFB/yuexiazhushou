import { api } from '../api/client'
import { RoomView } from '../domain/types'
import { Announcement, playAnnouncement, stopAnnouncement } from './announcer'

// An app session identifies this device; never share this token through room projections.
function newSessionId() { return `device_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` }
let sessionId = newSessionId()
let generation = 0
let expiresAt = 0
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let lastKey = ''
let active = false
let syncSequence = 0
let leaseVersion = -1

export function startBroadcast() { if (active) { generation += 1; return } sessionId = newSessionId(); active = true; generation += 1; lastKey = ''; expiresAt = 0; leaseVersion = -1 }
export function stopBroadcast() {
  if (!active) { stopAnnouncement(); return }
  active = false
  generation += 1
  expiresAt = 0
  lastKey = ''
  if (expiryTimer) clearTimeout(expiryTimer)
  stopAnnouncement()
  // Release only after sound has stopped. A failed release expires on the server.
  api.releaseBroadcast(sessionId).catch(() => undefined)
}

export async function syncBroadcast(room: RoomView, myId: string, name: Announcement | '', key: string, replay = false) {
  const sequence = ++syncSequence
  const requestGeneration = generation
  const requestSession = sessionId
  if (!active || room.broadcast.userId !== myId) {
    expiresAt = 0
    lastKey = ''
    stopAnnouncement()
    return false
  }
  if (!name) { lastKey = ''; stopAnnouncement() }
  if (leaseVersion === room.broadcast.version && expiresAt > Date.now()) {
    if (name && (replay || key !== lastKey)) { lastKey = key; playAnnouncement(name) }
    if (expiresAt - Date.now() > 5000) return true
  }
  const sentAt = Date.now()
  try {
    const lease = await api.heartbeatBroadcast(requestSession)
    if (!active || requestGeneration !== generation || sequence !== syncSequence) return false
    if (!lease.granted || lease.version !== room.broadcast.version) {
      expiresAt = 0
      lastKey = ''
      stopAnnouncement()
      return false
    }
    // Count from request start, so network latency never extends server ownership.
    expiresAt = sentAt + lease.leaseMs - 500
    leaseVersion = lease.version
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = setTimeout(() => { expiresAt = 0; lastKey = ''; stopAnnouncement() }, Math.max(0, expiresAt - Date.now()))
    if (expiresAt <= Date.now()) return false
    if (name && (replay || key !== lastKey)) { lastKey = key; playAnnouncement(name) }
    return true
  } catch (_) {
    if (!active || requestGeneration !== generation || sequence !== syncSequence) return false
    // Public text and the game continue even if audio ownership cannot be refreshed.
    if (Date.now() >= expiresAt) { lastKey = ''; stopAnnouncement() }
    return leaseVersion === room.broadcast.version && Date.now() < expiresAt
  }
}

export function chooseBroadcaster(room: RoomView): Promise<void> {
  const players = room.members.filter(item => !item.isBot)
  return new Promise((resolve, reject) => {
    wx.showActionSheet({ itemList: players.map(item => `${item.nickname}${item.userId === room.ownerId ? '（房主）' : ''}`),
      success: result => { api.transferBroadcast(players[result.tapIndex].userId, room.broadcast.version).then(() => { wx.showToast({ title: '播报权已更新', icon: 'none' }); resolve() }, reject) },
      fail: () => resolve(),
    })
  })
}
