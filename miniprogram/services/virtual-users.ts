// Deliberately in memory: simulator windows must not share a persisted identity.
let slot = ''
let generation = 0
export const virtualSlots = ['host', ...Array.from({ length: 15 }, (_, i) => `player-${i + 1}`)]
export function supportsVirtualUsers() { return wx.getDeviceInfo().platform === 'devtools' }
export function virtualUser() { return supportsVirtualUsers() ? slot : '' }
export function identityGeneration() { return generation }
export function selectVirtualUser(value: string) {
  if (!supportsVirtualUsers() || (value !== '' && !virtualSlots.includes(value))) return
  slot = value; generation += 1
}
export function virtualUserLabel() { const current = virtualUser(); return current === 'host' ? '虚拟用户 · 房主位' : current ? `虚拟用户 · 玩家 ${current.slice(7)}` : '真实微信账号' }
