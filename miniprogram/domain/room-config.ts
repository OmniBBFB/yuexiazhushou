import { GodRole } from './types'

export const roomSizes = Array.from({ length: 11 }, (_, i) => i + 6)
export const godRoles: GodRole[] = ['预言家', '女巫', '猎人', '守卫', '白痴', '守墓人', '骑士']

export function recommendBoard(total: number) {
  const wolves = Math.floor(total / 3)
  const selected = godRoles.slice(0, Math.min(4, wolves))
  return { total, wolves, gods: selected.length, villagers: total - wolves - selected.length, godRoles: selected }
}
