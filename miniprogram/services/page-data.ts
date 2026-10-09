import { renderFinished } from './telemetry'
// Keep setData payloads limited to fields whose displayed value changed.
export function setChangedData(page: { data: object; setData: (data: object, callback?: () => void) => void }, patch: object) {
  const previous = page.data as { [key: string]: unknown }
  const next = patch as { [key: string]: unknown }
  const changed: { [key: string]: unknown } = {}
  const displayValue = (key: string, value: unknown) => JSON.stringify(value, key === 'room' ? (field, item) => field === 'serverTime' ? undefined : item : undefined)
  for (const key of Object.keys(next)) {
    if (previous[key] !== next[key] && displayValue(key, previous[key]) !== displayValue(key, next[key])) changed[key] = next[key]
  }
  if (Object.keys(changed).length) {
    const room = (next.room || previous.room) as { id?: string; version?: number } | undefined
    const startedAt = Date.now()
    page.setData(changed, () => { if (room && room.id && room.version !== undefined) renderFinished(room.id, room.version, startedAt, Object.keys(changed).length) })
  }
}
