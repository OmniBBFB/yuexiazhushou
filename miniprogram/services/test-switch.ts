import { api } from '../api/client'
import { stopBroadcast } from './broadcast'
import { selectVirtualUser, supportsVirtualUsers, virtualSlots, virtualUser } from './virtual-users'

interface SwitchPage { onHide?: () => void; onShow?: () => unknown; writeDraft?: () => void; saveAll?: () => Promise<void> }
let switching = false
export async function switchTestIdentity(selected: string) {
  if (!supportsVirtualUsers() || switching || (selected !== '' && !virtualSlots.includes(selected))) return
  const previous = virtualUser()
  if (selected === previous) return
  switching = true
  const pages = getCurrentPages()
  const page = pages[pages.length - 1] as unknown as SwitchPage | undefined
  wx.showLoading({ title: '正在切换用户', mask: true })
  try {
    // Freeze old page requests and save drafts under the old identity before changing it.
    if (page && page.writeDraft) page.writeDraft()
    if (page && page.onHide) page.onHide()
    stopBroadcast()
    if (page && page.saveAll) await page.saveAll()
    selectVirtualUser(selected)
    const session = await api.session()
    const room = session.room
    const url = !room ? '/pages/index/index' : !room.game || room.status === 'WAITING' ? '/pages/room/room'
      : room.game.phase === 'ROLE_REVEAL' ? '/pages/role/role' : '/pages/game/game'
    await new Promise<void>((resolve, reject) => wx.reLaunch({ url, success: () => resolve(), fail: reject }))
  } catch (error) {
    selectVirtualUser(previous)
    if (page && page.onShow) page.onShow()
    throw error
  } finally { switching = false; wx.hideLoading() }
}
