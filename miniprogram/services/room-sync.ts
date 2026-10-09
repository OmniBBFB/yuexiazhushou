import { diagnostic, stateReceived, subscriptionError, recordSubscriptionError } from './telemetry'
import { api } from '../api/client'
import { RoomView, GameView, PublicRoomStateDocument, PersonalRoomStateDocument } from '../domain/types'
import { identityGeneration } from './virtual-users'
import { backendDatabase } from './backend'

// Subscribe only to permission-filtered public and caller-owned projections.
export function watchRoom(refresh: () => void, status: (connected: boolean) => void, current?: () => RoomView | null, receive?: (room: RoomView | null) => void): () => void {
  const generation = identityGeneration()
  let identity: Promise<{ userId: string; openid: string; virtual?: boolean }> | null = null
  let stopped = false, connectionEpoch = 0
  let watcher: { close: () => Promise<void> } | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let publicWatcher: { close: () => Promise<void> } | null = null
  let clockOffset = 0
  let publicRoom = '', publicState: PublicRoomStateDocument | null = null, personalState: PersonalRoomStateDocument | null = null, appliedRevision = 0
  const apply = () => {
    if (!receive || stopped || generation !== identityGeneration() || !publicState || !personalState) return
    if (publicState.roomId !== personalState.roomId || publicState.privateVersions[personalState._id] !== personalState.revision || publicState.revision <= appliedRevision) {
      if (publicState.revision > appliedRevision) diagnostic('subscription_version_wait', { roomId: publicState.roomId, revision: publicState.revision, expectedPrivateRevision: publicState.privateVersions[personalState._id], privateRevision: personalState.revision })
      return
    }
    const room = JSON.parse(JSON.stringify(publicState.state)) as RoomView
    if (room.game) {
      const privateGame = personalState.state && personalState.state.game || {}
      room.game = { ...room.game, ...privateGame, serverTime: Date.now() + clockOffset } as GameView
      if (publicState.state.game && publicState.state.game.dayView) room.game!.dayView = { ...publicState.state.game!.dayView, ...privateGame.dayView } as GameView['dayView']
    }
    appliedRevision = publicState.revision
    stateReceived(room.id, room.version, publicState.revision)
    delay = 1000
    receive(room); status(true)
  }
  const watchPublic = (roomId: string, openid: string) => {
    if (publicRoom === roomId) return
    if (publicWatcher) { publicWatcher.close().catch(() => undefined); publicWatcher = null }
    publicRoom = roomId; publicState = null; appliedRevision = 0
    if (!roomId) return
    const epoch = connectionEpoch
    try {
      const database = backendDatabase()
      publicWatcher = database.collection('room_states').where({ _id: roomId, readers: database.command.in([openid]) }).watch({
        onChange: snapshot => {
          if (stopped || generation !== identityGeneration() || publicRoom !== roomId || epoch !== connectionEpoch) return
          const doc = snapshot.docs.find((value: { _id: string }) => value._id === roomId) as PublicRoomStateDocument | undefined
          if (doc) diagnostic('subscription_received', { channel: 'public', roomId: doc.roomId, revision: doc.revision })
          if (doc && (!publicState || doc.revision >= publicState.revision)) { publicState = doc; apply() }
        }, onError: error => {
          if (epoch === connectionEpoch && publicRoom === roomId) {
            reconnect('public', error);
          }
        },
      })
    } catch (error) { if (epoch === connectionEpoch) reconnect('public', error) }
  }
  let delay = 1000
  let last = ''
  const connect = async () => {
    const epoch = ++connectionEpoch
    let channel = 'identity'
    try {
      if (!identity) identity = api.syncIdentity().catch(error => { identity = null; throw error })
      const caller = await identity
      if (stopped || generation !== identityGeneration() || epoch !== connectionEpoch) return
      if (receive && !caller.virtual) {
        channel = 'bootstrap'
        const sentAt = Date.now(), snapshot = await api.subscribeRoom(), receivedAt = Date.now()
        if (stopped || generation !== identityGeneration() || epoch !== connectionEpoch) return
        if (!snapshot) { delay = 1000; receive(null); status(true); return }
        if (snapshot && snapshot.game && snapshot.game.serverTime) clockOffset = snapshot.game.serverTime - (sentAt + receivedAt) / 2
      }
      if (stopped || generation !== identityGeneration() || epoch !== connectionEpoch) return
      channel = 'personal'
      watcher = backendDatabase().collection('room_signals').where({ _openid: caller.openid, _id: caller.userId }).watch({
        onChange: snapshot => {
          if (stopped || generation !== identityGeneration() || epoch !== connectionEpoch) return
          if (!receive || caller.virtual) { delay = 1000; status(true) }
          const signal = snapshot.docs.find((doc: { _id: string }) => doc._id === caller.userId) as PersonalRoomStateDocument | undefined
          if (!signal) return
          diagnostic('subscription_received', { channel: 'personal', roomId: signal.roomId, revision: signal.revision })
          if (receive && signal.protocol === 2) {
            if (!signal.roomId) { delay = 1000; personalState = signal; watchPublic('', caller.openid); receive(null); status(true); return }
            if (!personalState || signal.roomId !== personalState.roomId || signal.revision >= personalState.revision) personalState = signal
            watchPublic(signal.roomId, caller.openid); apply(); return
          }
          const key = `${signal.roomId}:${signal.version}:${signal.broadcastVersion}`
          if (key !== last) {
            last = key
            const room = current && current()
            if (!room || signal.roomId !== room.id || signal.version > room.version || signal.broadcastVersion > room.broadcast.version) refresh()
          }
        },
        onError: error => {
          if (epoch === connectionEpoch) {
            reconnect('personal', error);
          }
        },
      })
    } catch (error) { if (epoch === connectionEpoch) reconnect(channel, error) }
  }
  const reconnect = (channel: string, error?: unknown) => {
    if (stopped || generation !== identityGeneration()) return
    recordSubscriptionError(channel, error, delay)
    diagnostic('subscription_reconnect', { channel, retryDelayMs: delay, ...subscriptionError(error) })
    connectionEpoch += 1
    status(false)
    if (watcher) { watcher.close().catch(() => undefined); watcher = null }
    if (publicWatcher) { publicWatcher.close().catch(() => undefined); publicWatcher = null }
    publicRoom = ''; publicState = null; personalState = null; appliedRevision = 0
    if (retry) clearTimeout(retry)
    retry = setTimeout(() => { retry = null; connect() }, Math.round(delay * (0.85 + Math.random() * 0.3)))
    delay = Math.min(delay * 2, 30000)
  }
  connect()
  return () => { stopped = true; if (retry) clearTimeout(retry); if (watcher) watcher.close().catch(() => undefined); if (publicWatcher) publicWatcher.close().catch(() => undefined) }
}
