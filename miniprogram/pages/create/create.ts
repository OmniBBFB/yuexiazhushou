import { api, showError } from '../../api/client'
import { GodRole, WolfRole } from '../../domain/types'
import { godRoles, recommendBoard, roomSizes } from '../../domain/room-config'

const initial = recommendBoard(9)
function boardCards(total: number) {
  const names: { [key: number]: string } = { 6: '预女基础局', 9: '预女猎经典局', 12: '预女猎守标准局' }
  return [...new Set([6, 9, 12, total])].sort((a, b) => a - b).map(size => ({ ...recommendBoard(size), name: names[size] || `${size} 人推荐阵容` }))
}
Page({
  data: { ...initial, sizes: roomSizes, sizeIndex: 3, presets: [6, 9, 12], custom: false,
    boards: boardCards(9), godOptions: godRoles.map(role => ({ role, checked: initial.godRoles.includes(role) })),
    wolfRoles: [] as WolfRole[], wolfOptions: [{ role: '白狼王', checked: false }, { role: '狼王', checked: false }], wildChild: false, configError: '', winMode: '屠边' as '屠边' | '屠城', interval: 3, password: '', submitting: false },
  applyBoard(total: number, wolves: number, selected: GodRole[]) {
    const villagers = total - wolves - selected.length
    const wolfRoles = this.data.wolfRoles.slice(0, wolves)
    const configError = !selected.length ? '请至少选择一种神职' : wolves < 1 || wolves * 2 >= total ? '狼人须至少一人且少于总人数的一半' : villagers < 1 ? '请至少保留一个平民名额' : ''
    this.setData({ wolfRoles, wolfOptions: ['白狼王', '狼王'].map(role => ({ role, checked: wolfRoles.includes(role as WolfRole) })), total, sizeIndex: roomSizes.indexOf(total), wolves, gods: selected.length, villagers, godRoles: selected, boards: boardCards(total), godOptions: godRoles.map(role => ({ role, checked: selected.includes(role) })), configError })
  },
  pickSize(e: WechatMiniprogram.TouchEvent) {
    const board = recommendBoard(Number(e.currentTarget.dataset.size))
    this.setData({ custom: false }); this.applyBoard(board.total, board.wolves, board.godRoles)
  },
  sizeChange(e: WechatMiniprogram.PickerChange) {
    const total = roomSizes[Number(e.detail.value)]
    if (this.data.custom) this.applyBoard(total, this.data.wolves, this.data.godRoles)
    else { const board = recommendBoard(total); this.applyBoard(total, board.wolves, board.godRoles) }
  },
  pickConfigMode(e: WechatMiniprogram.TouchEvent) {
    const custom = e.currentTarget.dataset.mode === 'custom'
    this.setData({ custom })
    if (!custom) { const board = recommendBoard(this.data.total); this.applyBoard(board.total, board.wolves, board.godRoles) }
  },
  changeWolves(e: WechatMiniprogram.TouchEvent) {
    const wolves = this.data.wolves + Number(e.currentTarget.dataset.delta)
    if (wolves < 1 || wolves >= this.data.total) return
    this.applyBoard(this.data.total, wolves, this.data.godRoles)
  },
  godsChange(e: WechatMiniprogram.CheckboxGroupChange) { this.applyBoard(this.data.total, this.data.wolves, godRoles.filter(role => e.detail.value.includes(role))) },
  toggleGod(e: WechatMiniprogram.TouchEvent) { const role = String(e.currentTarget.dataset.role); const selected = this.data.godRoles; this.applyBoard(this.data.total, this.data.wolves, godRoles.filter(value => value === role ? !selected.includes(value) : selected.includes(value))) },
  toggleWolf(e: WechatMiniprogram.TouchEvent) {
    const role = e.currentTarget.dataset.role as WolfRole, selected = this.data.wolfRoles
    const wolfRoles = selected.includes(role) ? selected.filter(value => value !== role) : [...selected, role]
    if (wolfRoles.length > this.data.wolves) { wx.showToast({ title: '特殊狼人不能超过狼人名额', icon: 'none' }); return }
    this.setData({ wolfRoles, wolfOptions: ['白狼王', '狼王'].map(value => ({ role: value, checked: wolfRoles.includes(value as WolfRole) })) })
  },
  toggleWildChild(e: WechatMiniprogram.SwitchChange) { this.setData({ wildChild: e.detail.value }) },
  pickMode(e: WechatMiniprogram.TouchEvent) { this.setData({ winMode: e.currentTarget.dataset.mode }) },
  intervalChange(e: WechatMiniprogram.SliderChange) { this.setData({ interval: e.detail.value }) },
  passwordInput(e: WechatMiniprogram.Input) { this.setData({ password: e.detail.value }) },
  async submit() {
    if (this.data.submitting || this.data.configError) return
    this.setData({ submitting: true }); wx.showLoading({ title: '创建中' })
    try {
      await api.createRoom({ total: this.data.total, wolves: this.data.wolves, gods: this.data.gods, villagers: this.data.villagers, godRoles: this.data.godRoles, wolfRoles: this.data.wolfRoles, wildChild: this.data.wildChild, winMode: this.data.winMode, interval: this.data.interval, password: this.data.password })
      wx.hideLoading(); this.setData({ submitting: false }); wx.redirectTo({ url: '/pages/room/room' })
    } catch (error) { wx.hideLoading(); this.setData({ submitting: false }); showError(error) }
  },
})
