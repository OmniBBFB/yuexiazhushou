import { RelationEdge } from './types'
export function setRelation(edges: RelationEdge[], edge: RelationEdge): RelationEdge[] {
  if (edge.source === edge.target) return edges
  const previous = edges.find(item => item.source === edge.source && item.target === edge.target)
  if (previous && previous.type === edge.type) return edges
  return [...edges.filter(item => item.source !== edge.source || item.target !== edge.target), { ...edge }]
}
export function validRelations(value: unknown, seats: number[]): value is RelationEdge[] {
  if (!Array.isArray(value) || value.length > 240) return false
  const pairs = new Set<string>()
  return value.every(edge => {
    if (!edge || !seats.includes(edge.source) || !seats.includes(edge.target) || edge.source === edge.target || !['ATTACK', 'SUPPORT'].includes(edge.type)) return false
    const key = `${edge.source}:${edge.target}`
    if (pairs.has(key)) return false
    pairs.add(key); return true
  })
}
export function seatPositions(seats: number[]) {
  return seats.map((seat, index) => {
    const angle = index * Math.PI * 2 / seats.length - Math.PI / 2
    return { seat, x: 50 + Math.cos(angle) * 40, y: 50 + Math.sin(angle) * 40 }
  })
}
