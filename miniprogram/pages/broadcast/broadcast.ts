import { setChangedData } from '../../services/page-data'
import { api, showError } from '../../api/client'
import { RoomView } from '../../domain/types'
import { announcementFor } from '../../services/announcements'
import { chooseBroadcaster, startBroadcast, stopBroadcast, syncBroadcast } from '../../services/broadcast'
import { watchRoom } from '../../services/room-controller'

Page({
  data: { room: null as RoomView | null, myId: '', isOwner: false, loading: true, playingHere: false, announcementText: '', transferring: false },
  visible: false, returning: false, epoch: 0, fetching: false, pendingSnapshot: undefined as RoomView | null | undefined, pendingRefresh: false, lastFetch: 0, syncConnected: false,
  poller: 0 as number, heartbeat: 0 as number, deadline: 0 as number, stopSync: (() => {}) as () => void,
  async onShow() {
    this.visible = true; this.returning = false; this.epoch++; this.fetching = false; this.pendingRefresh = false; this.pendingSnapshot = undefined
    this.setData({ myId: '', isOwner: false, playingHere: false }); startBroadcast()
    await this.load(true)
    if (!this.visible) return
    this.stopSync = watchRoom(() => this.load(false), value => { this.syncConnected = value }, () => this.data.room, room => { void this.load(false, room) })
    
    this.heartbeat = setInterval(() => this.announce(), 3000) as unknown as number
  },
  onHide() {
    if (!this.visible) return
    this.visible = false; this.epoch++; this.stopSync(); this.syncConnected = false
    clearInterval(this.poller); clearInterval(this.heartbeat); clearTimeout(this.deadline)
    if (!this.returning) stopBroadcast()
  },
  onUnload() { this.onHide() },
  async load(showFailure: boolean, snapshot?: RoomView | null): Promise<boolean | void> {
    if (!this.visible) return
    if (this.fetching) { this.pendingRefresh = true; if (snapshot !== undefined) this.pendingSnapshot = snapshot; return }
    const epoch = this.epoch; this.fetching = true
    try {
      const knownId = this.data.myId
      const session = snapshot !== undefined ? { profile: { id: knownId }, room: snapshot } : knownId ? { profile: { id: knownId }, room: await api.getRoom() } : await api.session()
      if (!this.visible || epoch !== this.epoch) return
      if (!session.room) { wx.reLaunch({ url: '/pages/index/index' }); return }
      const room = session.room, previous = this.data.room
      if (previous && room.id === previous.id && (room.version < previous.version || room.broadcast.version < previous.broadcast.version)) return
      this.lastFetch = Date.now()
      setChangedData(this, { room, myId: session.profile.id, isOwner: room.ownerId === session.profile.id, loading: false })
      this.announce()
      return true
    } catch (error) { if (this.visible && epoch === this.epoch) { this.setData({ loading: false }); if (showFailure) showError(error) }; return false }
    finally { if (epoch === this.epoch) { this.fetching = false; if (this.pendingRefresh) { this.pendingRefresh = false; const pending = this.pendingSnapshot; this.pendingSnapshot = undefined; this.load(false, pending) } } }
  },
  async announce(replay = false) {
    const room = this.data.room
    if (!this.visible || !room) return
    if (!room.game) { this.setData({ announcementText: '', playingHere: false }); return }
    const epoch = this.epoch, current = announcementFor(room)
    this.setData({ announcementText: current.text })
    // Use the same cue identity as the game page to avoid replaying on navigation.
    const game = room.game, key = game ? `${game.id}:${game.day}:${game.phase}:${game.nightStage}:${game.nightCue}` : ''
    const playingHere = await syncBroadcast(room, this.data.myId, current.name, key, replay)
    if (this.visible && epoch === this.epoch && this.data.room === room) this.setData({ playingHere })
  },
  async transferBroadcast() {
    if (!this.data.room || !this.data.isOwner || this.data.transferring) return
    this.setData({ transferring: true })
    try { await chooseBroadcaster(this.data.room) }
    catch (error) { showError(error); await this.load(false) }
    finally { this.setData({ transferring: false }) }
  },
  replay() { if (this.data.playingHere) this.announce(true) },
  retry() { this.load(true) },
  back() {
    this.returning = !!this.data.room && !!this.data.room.game
    wx.navigateBack({ fail: () => { this.returning = false; wx.reLaunch({ url: this.data.room && this.data.room.game ? '/pages/game/game' : '/pages/room/room' }) } })
  },
})
