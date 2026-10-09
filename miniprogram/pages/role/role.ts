import { api, showError } from '../../api/client'
import { RoomView } from '../../domain/types'
import { setChangedData } from '../../services/page-data'
import { watchRoom } from '../../services/room-controller'

const icons: { [key: string]: string } = { '狼人': '♠', '预言家': '◉', '女巫': '⚗', '猎人': '⌁', '守卫': '⬡', '村民': '◇', '野孩子': '♧', '白痴': '◇', '守墓人': '◈', '骑士': '⚔', '白狼王': '♠', '狼王': '♠' }
Page({
  data: { room: null as RoomView | null, revealed: false, role: '', roleIcon: '', description: '', confirmed: false, confirmedCount: 0, totalCount: 0 }, poller: 0 as number, leaving: false,
  visible: false,
  stopSync: (() => {}) as () => void,
  syncConnected: false,
  pendingRefresh: false,
  lastRefreshAt: 0,
  deadlineTimer: 0 as number,
  loadEpoch: 0,
  loadingRequest: false,
  async onShow() { this.visible = true; this.leaving = false; this.loadEpoch += 1; this.loadingRequest = false; this.pendingRefresh = false; clearInterval(this.poller); await this.load(true); if (this.visible && !this.leaving) { this.stopSync = watchRoom(() => this.load(false), connected => { this.syncConnected = connected }, () => this.data.room, room => this.applyRoom(room));  } },
  onHide() { this.visible = false; this.stopSync(); this.syncConnected = false; clearTimeout(this.deadlineTimer); this.loadEpoch += 1; clearInterval(this.poller) }, onUnload() { this.onHide() },
  async load(showFailure: boolean): Promise<boolean | void> {
    if (!this.visible || this.leaving) return
    if (this.loadingRequest) { this.pendingRefresh = true; return }
    const epoch = this.loadEpoch
    this.loadingRequest = true
    try {
      const room = await api.getRoom();
      if (!this.visible || epoch !== this.loadEpoch) return
      this.lastRefreshAt = Date.now()
      this.applyRoom(room)
      return true
    } catch (error) { if (showFailure && this.visible && epoch === this.loadEpoch) showError(error); return false }
    finally { if (epoch === this.loadEpoch) { this.loadingRequest = false; if (this.pendingRefresh) { this.pendingRefresh = false; this.load(false) } } }
  },
  navigateAway(url: string, relaunch = false) {
    if (!this.visible || this.leaving) return
    this.leaving = true
    const epoch = this.loadEpoch
    const options = { url, fail: (error: WechatMiniprogram.GeneralCallbackResult) => {
      if (!this.visible || epoch !== this.loadEpoch) return
      this.leaving = false
      showError(error)
    } }
    if (relaunch) wx.reLaunch(options)
    else wx.redirectTo(options)
  },
  applyRoom(room: RoomView | null) {
    if (!this.visible || this.leaving) return
    const current = this.data.room
    if (room && current && room.id === current.id && (room.version < current.version || room.broadcast.version < current.broadcast.version)) return
    if (!room) { this.navigateAway('/pages/index/index', true); return }
    if (!room.game) { this.navigateAway('/pages/room/room'); return } if (room.game.phase !== 'ROLE_REVEAL') { clearInterval(this.poller); this.navigateAway('/pages/game/game'); return } const mine = room.game.myRole; setChangedData(this, { room, role: mine ? mine.role : '', roleIcon: mine ? icons[mine.role] : '', description: mine ? mine.description : '', confirmed: mine ? mine.confirmed : false, confirmedCount: room.game.confirmedCount, totalCount: room.game.totalCount })
  },
  reveal() { this.setData({ revealed: true }) },
  async confirm() { const room = this.data.room; if (!room) return; try { await api.confirmRole(room.version); this.setData({ revealed: false, confirmed: true }); } catch (error) { showError(error); await this.load(false) } },
})
