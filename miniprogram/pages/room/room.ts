import { api, showError } from '../../api/client'
import { MemberView, RoomView } from '../../domain/types'
import { setChangedData } from '../../services/page-data'
import { watchRoom, serverOffset } from '../../services/room-controller'
import { virtualUser } from '../../services/virtual-users'
interface SeatView { seat: number; avatar: string; member?: MemberView }
Page({
  data: { room: null as RoomView | null, seats: [] as SeatView[], myId: '', mySeat: 0, pendingSeat: 0, myReady: false, isOwner: false, progress: 0, readyCount: 0, full: false, canStart: false, loading: true, starting: false, rotatingSeats: false, isVirtualTest: false, preparingVirtualPlayers: false },
  seatAckVersion: 0, seatTimeout: 0 as number,
  poller: 0 as number,
  serverClockOffset: 0,
  loadEpoch: 0,
  loadingRequest: false,
  visible: false,
  leaving: false,
  stopSync: (() => {}) as () => void,
  syncConnected: false,
  pendingRefresh: false,
  lastRefreshAt: 0,
  deadlineTimer: 0 as number,
  async onShow() { this.visible = true; this.leaving = false; this.loadEpoch += 1; this.loadingRequest = false; this.pendingRefresh = false; this.setData({ isVirtualTest: !!virtualUser(), isOwner: false, myId: '', mySeat: 0, pendingSeat: 0, myReady: false }); clearInterval(this.poller); await this.load(true); if (this.visible && !this.leaving) { this.stopSync = watchRoom(() => this.load(false), connected => { this.syncConnected = connected }, () => this.data.room, room => this.applyRoom(room));  } },
  onHide() { this.visible = false; this.stopSync(); this.syncConnected = false; clearTimeout(this.seatTimeout); clearTimeout(this.deadlineTimer); this.loadEpoch += 1; clearInterval(this.poller) }, onUnload() { this.onHide() },
  async rotateSeats() {
    const room = this.data.room
    if (!room || !this.data.isOwner || room.status !== 'WAITING' || this.data.rotatingSeats || this.data.starting) return
    this.setData({ rotatingSeats: true })
    try { await api.rotateSeats(room.version); wx.showToast({ title: '座位已轮换，请重新准备', icon: 'none' }) }
    catch (error) { showError(error); await this.load(false) }
    finally { this.setData({ rotatingSeats: false }) }
  },
  openBroadcast() { wx.navigateTo({ url: '/pages/broadcast/broadcast' }) },
  async readyVirtualPlayers() {
    const room = this.data.room
    if (!room || !this.data.isOwner || !this.data.isVirtualTest || room.status !== 'WAITING' || this.data.preparingVirtualPlayers || this.data.starting) return
    this.setData({ preparingVirtualPlayers: true })
    try { await api.readyVirtualPlayers(room.version) }
    catch (error) { showError(error); await this.load(false) }
    finally { this.setData({ preparingVirtualPlayers: false }) }
  },
  async load(showFailure: boolean): Promise<boolean | void> {
    if (!this.visible || this.leaving) return
    if (this.loadingRequest) { this.pendingRefresh = true; return }
    const epoch = this.loadEpoch
    this.loadingRequest = true
    try {
      const sentAt = Date.now()
      const session = this.data.myId ? { profile: { id: this.data.myId }, room: await api.getRoom() } : await api.session();
      if (!this.visible || epoch !== this.loadEpoch) return
      this.lastRefreshAt = Date.now()
      if (session.room) this.serverClockOffset = serverOffset(session.room, sentAt, this.lastRefreshAt)
      if (!session.profile || !session.profile.id) throw new Error('无法识别当前账号，请重新进入');
      if (this.data.myId !== session.profile.id) this.setData({ myId: session.profile.id }); this.applyRoom(session.room)
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
    
    if (!room) { this.navigateAway('/pages/index/index', true); return } if (room.status !== 'WAITING' && room.game) { clearInterval(this.poller); this.navigateAway(room.game.phase === 'ROLE_REVEAL' ? '/pages/role/role' : '/pages/game/game'); return } const me = room.members.find(item => item.userId === this.data.myId); if (this.data.pendingSeat && (me && me.seat === this.data.pendingSeat || this.seatAckVersion && room.version >= this.seatAckVersion)) { clearTimeout(this.seatTimeout); this.setData({ pendingSeat: 0 }); this.seatAckVersion = 0 } const seats: SeatView[] = []; for (let seat = 1; seat <= room.config.total; seat += 1) { const item = room.members.find(value => value.seat === seat); seats.push({ seat, member: item, avatar: item ? item.nickname.substring(0, 1) : '+' }) } const readyCount = room.members.filter(item => item.ready).length; const full = room.members.length === room.config.total; setChangedData(this, { room, seats, myId: this.data.myId, mySeat: me ? me.seat : 0, myReady: me ? me.ready : false, isOwner: !!this.data.myId && !!room.ownerId && room.ownerId === this.data.myId, readyCount, full, canStart: full && readyCount === room.config.total && room.members.every(item => !!item.seat), progress: Math.round(room.members.length / room.config.total * 100), loading: false })
  },
  async pickSeat(e: WechatMiniprogram.TouchEvent) {
    const clickedAt = Date.now(), room = this.data.room
    if (!room || room.status !== 'WAITING' || this.data.pendingSeat || this.data.rotatingSeats || this.data.starting) return
    const seat = Number(e.currentTarget.dataset.seat)
    if (seat === this.data.mySeat) return
    if (room.members.some(item => item.seat === seat && item.userId !== this.data.myId)) { wx.showToast({ title: '该座位已被占用', icon: 'none' }); return }
    const epoch = this.loadEpoch
    this.seatAckVersion = 0; this.setData({ pendingSeat: seat })
    try {
      const ack = await api.selectSeat(seat, room.version, clickedAt)
      if (!this.visible || epoch !== this.loadEpoch || !this.data.pendingSeat) return
      this.seatAckVersion = ack.version
      if (this.data.room && this.data.room.version >= ack.version) { this.applyRoom(this.data.room); return }
      this.seatTimeout = setTimeout(async () => {
        if (!this.visible || epoch !== this.loadEpoch) return
        await this.load(false)
        if (this.visible && epoch === this.loadEpoch && this.data.pendingSeat) {
          this.setData({ pendingSeat: 0 }); wx.showToast({ title: '同步较慢，请稍后重试', icon: 'none' })
        }
      }, 10000) as unknown as number
    } catch (error) {
      if (this.visible && epoch === this.loadEpoch) { this.setData({ pendingSeat: 0 }); showError(error); await this.load(false) }
    }
  },
  async toggleReady() { const room = this.data.room; if (!room) return; try { await api.setReady(!this.data.myReady, room.version); } catch (error) { showError(error); await this.load(false) } },
  async addBots() { const room = this.data.room; if (!room || !this.data.isOwner || this.data.full) return; wx.showLoading({ title: '机器人入座中' }); try { await api.addBots(room.version); wx.hideLoading(); } catch (error) { wx.hideLoading(); showError(error); await this.load(false) } },
  async start() { const room = this.data.room; if (!room || !this.data.isOwner || !this.data.canStart || this.data.starting) return; this.setData({ starting: true }); wx.showLoading({ title: '分配身份中' }); try { await api.startGame(room.version); wx.hideLoading(); this.setData({ starting: false }) } catch (error) { wx.hideLoading(); this.setData({ starting: false }); showError(error) } },
  leave() { wx.showModal({ title: this.data.isOwner ? '解散房间？' : '离开房间？', content: this.data.isOwner ? '所有玩家都会离开当前房间，对局和相关笔记将被清除。' : '你的座位和准备状态将被释放。', confirmColor: '#c96f6f', success: async result => { if (!result.confirm) return; try { await api.exitRoom(); clearInterval(this.poller); this.navigateAway('/pages/index/index', true) } catch (error) { showError(error) } } }) },
})
