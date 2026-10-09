import { api, showError } from '../../api/client'
import { watchRoom } from '../../services/room-controller'
import { ProfileView, RoomView } from '../../domain/types'
import { selectVirtualUser } from '../../services/virtual-users'
Page({
  data: { profile: {} as ProfileView, avatarText: '玩', hasRoom: false, roomCode: '', roomPlaying: false, loading: true, switchingUser: false, exitingRoom: false },
  loadEpoch: 0, visible: false, room: null as RoomView | null, stopSync: (() => {}) as () => void,
  onLoad(query: { virtualUser?: string }) { if (query.virtualUser) selectVirtualUser(query.virtualUser) },
  async onShow() {
    this.visible = true; this.stopSync(); await this.load()
    if (this.visible && this.room) this.stopSync = watchRoom(() => this.load(), () => {}, () => this.room, room => {
      if (!this.visible || this.data.exitingRoom) return
      this.room = room; this.setData({ hasRoom: !!room, roomCode: room ? room.code : '', roomPlaying: !!room && !!room.game && room.status !== 'WAITING' })
    })
  },
  onHide() { this.visible = false; this.stopSync(); this.loadEpoch += 1 },
  onUnload() { this.onHide() },
  async load() { if (this.data.exitingRoom) return; const epoch = ++this.loadEpoch; try { const session = await api.session(); if (epoch !== this.loadEpoch) return; this.room = session.room; this.setData({ profile: session.profile, avatarText: session.profile.nickname.substring(0, 1), hasRoom: !!session.room, roomCode: session.room ? session.room.code : '', roomPlaying: !!session.room && !!session.room.game && session.room.status !== 'WAITING', loading: false }) } catch (error) { if (epoch !== this.loadEpoch) return; this.setData({ loading: false }); showError(error) } },
  goCreate() { if (!this.data.switchingUser) wx.navigateTo({ url: '/pages/create/create' }) },
  goJoin() { if (!this.data.switchingUser) wx.navigateTo({ url: '/pages/join/join' }) },
  goProfile() { if (!this.data.switchingUser) wx.navigateTo({ url: '/pages/profile/profile' }) },
  resume() { if (!this.data.switchingUser) wx.navigateTo({ url: this.data.roomPlaying ? '/pages/game/game' : '/pages/room/room' }) },
  exitRoom() {
    if (!this.data.hasRoom || this.data.switchingUser || this.data.exitingRoom) return
    this.loadEpoch += 1; this.setData({ exitingRoom: true })
    wx.showModal({ title: '退出当前房间？', content: '如果你是房主，房间、当前对局和相关笔记将被清除；其他玩家将同时退出。', confirmText: '确认退出', confirmColor: '#c96f6f',
      success: async result => {
        if (!result.confirm) { this.setData({ exitingRoom: false }); this.load(); return }
        wx.showLoading({ title: '正在清理', mask: true })
        let failed = false
        try {
          const session = await api.exitRoom()
          if (session.room) throw new Error('服务器仍返回当前房间，请更新 api 云函数')
          this.setData({ profile: session.profile, hasRoom: false, roomCode: '', roomPlaying: false })
          wx.showToast({ title: '已退出房间' })
        } catch (error) {
          failed = true
          wx.showModal({ title: '退出房间失败', content: error instanceof Error ? error.message : '请求失败，请查看 api 云函数日志', showCancel: false })
        } finally { wx.hideLoading(); this.loadEpoch += 1; this.setData({ exitingRoom: false }); if (failed) this.load() }
      },
      fail: error => {
        this.setData({ exitingRoom: false })
        console.warn('退出确认弹窗失败', error.errMsg)
        showError(new Error(`无法打开确认弹窗：${error.errMsg || '请重试'}`))
        this.load()
      },
    })
  },
})
