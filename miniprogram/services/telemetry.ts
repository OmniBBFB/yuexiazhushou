// Local structured diagnostics only. Never attach operation payloads or game data.
interface Operation { action: string; requestId: string; startedAt: number; sentAt: number; roomId?: string; version?: number; received?: boolean }
const pending = new Map<string, Operation>()
const snapshots: { roomId: string; version: number; at: number; renderedAt?: number }[] = []
const maxAge = 60000
export function diagnostic(event: string, fields: { [key: string]: string | number | boolean | undefined } = {}) {
  try { console.info('client metrics', { event, clientAt: Date.now(), ...fields }) } catch (_) { /* Diagnostics never block gameplay. */ }
}
function prune() {
  const now = Date.now()
  for (const [key, item] of pending) if (now - item.startedAt > maxAge) { diagnostic('operation_timeout', { action: item.action, requestId: key, durationMs: now - item.startedAt }); pending.delete(key) }
  while (pending.size > 100) pending.delete(pending.keys().next().value!)
  while (snapshots.length && (snapshots.length > 32 || now - snapshots[0].at > maxAge)) snapshots.shift()
}
export function beginOperation(action: string, requestId: string, startedAt = Date.now()) {
  prune()
  const sentAt = Date.now()
  pending.set(requestId, { action, requestId, startedAt, sentAt })
  prune()
  diagnostic('request_sent', { action, requestId, localMs: Math.max(0, sentAt - startedAt) })
}
export function finishRequest(action: string, requestId: string, sentAt: number, errorCode?: string, ack?: { roomId: string; version: number }) {
  diagnostic('request_finished', { action, requestId, roundTripMs: Math.max(0, Date.now() - sentAt), ok: !errorCode, errorCode })
  const item = pending.get(requestId)
  if (!item) return
  if (errorCode || !ack) { pending.delete(requestId); return }
  item.roomId = ack.roomId; item.version = ack.version
  // Push may arrive before the command acknowledgement.
  const received = snapshots.find(snapshot => snapshot.roomId === ack.roomId && snapshot.version >= ack.version && snapshot.at >= item.sentAt)
  if (received) { recordReceived(item, received.at); if (received.renderedAt !== undefined) completeRender(item, received.renderedAt) }
}
function recordReceived(item: Operation, at: number) {
  if (item.received) return
  item.received = true
  diagnostic('operation_state_received', { action: item.action, requestId: item.requestId, roomId: item.roomId, version: item.version, endToEndMs: Math.max(0, at - item.startedAt) })
}
export function stateReceived(roomId: string, version: number, revision?: number) {
  prune()
  const at = Date.now()
  snapshots.push({ roomId, version, at })
  prune()
  diagnostic('subscription_applied', { roomId, version, revision })
  for (const item of pending.values()) if (item.roomId === roomId && item.version !== undefined && version >= item.version) recordReceived(item, at)
}
function completeRender(item: Operation, at: number) {
  diagnostic('operation_rendered', { action: item.action, requestId: item.requestId, roomId: item.roomId, version: item.version, endToEndMs: Math.max(0, at - item.startedAt) })
  pending.delete(item.requestId)
}
export function renderFinished(roomId: string, version: number, startedAt: number, fields: number) {
  diagnostic('render_finished', { roomId, version, renderMs: Math.max(0, Date.now() - startedAt), fields })
  const at = Date.now()
  for (const snapshot of snapshots) if (snapshot.roomId === roomId && snapshot.version === version && snapshot.at <= startedAt) snapshot.renderedAt = at
  for (const item of pending.values()) if (item.roomId === roomId && item.version !== undefined && version >= item.version && item.received) {
    completeRender(item, at)
  }
}
export function resetDiagnostics() { pending.clear(); snapshots.length = 0 }

export function subscriptionError(error: unknown): { errorCode: string; reason: string } {
  const value = error as { code?: unknown; errCode?: unknown; message?: unknown; errMsg?: unknown } | null
  const rawCode = value && (value.code ?? value.errCode)
  const code = typeof rawCode === 'number' || typeof rawCode === 'string' ? String(rawCode) : ''
  const errorCode = /^[a-zA-Z0-9_-]{1,96}$/.test(code) ? code : 'UNKNOWN'
  // The SDK can wrap the underlying failure in errMsg/cause; message may only
  // describe the outer initialization error. Inspect both without logging text.
  const pieces: string[] = [code]
  const seen = new Set<object>()
  const inspect = (input: unknown, depth: number) => {
    if (typeof input === 'string' || typeof input === 'number') { pieces.push(String(input).slice(0, 2000)); return }
    if (!input || typeof input !== 'object' || depth > 3 || seen.has(input)) return
    seen.add(input)
    const fields = input as { [key: string]: unknown }
    for (const key of ['code', 'errCode', 'message', 'errMsg', 'cause', 'originalError']) inspect(fields[key], depth + 1)
  }
  inspect(error, 0)
  const text = pieces.join(' ').toLowerCase()
  const reason = /permission|unauthoriz|denied|权限/.test(text) ? 'permission_denied'
    : /index|索引/.test(text) ? 'index_required'
    : /collection.*(not.*exist|does.*exist)|集合.*不存在/.test(text) ? 'collection_missing'
    : /unsupported|not supported|invalid.*(query|param)|不支持/.test(text) ? 'query_or_api_invalid'
    : /network|socket|timeout|timedout|timed out|disconnect|网络|超时/.test(text) ? 'network_or_timeout' : 'unknown'
  return { errorCode, reason }
}

// Explicit local troubleshooting log. Only error fields, never snapshots or queries.
export const subscriptionErrorStorageKey = 'subscription_errors_v1'
export function recordSubscriptionError(channel: string, error: unknown, retryDelayMs: number) {
  try {
    const seen = new Set<object>()
    let remaining = 8000
    const serialize = (value: unknown, depth: number): unknown => {
      if (remaining <= 0) return '[truncated]'
      if (typeof value === 'string') {
        const text = value.slice(0, Math.min(2000, remaining))
        remaining -= text.length
        return text
      }
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
      if (typeof value !== 'object') return undefined
      if (seen.has(value)) return '[circular]'
      if (depth > 3) return '[max depth]'
      seen.add(value)
      const result: { [key: string]: unknown } = {}
      // Error.message/stack are commonly non-enumerable: JSON.stringify alone loses them.
      for (const key of ['name', 'code', 'errCode', 'message', 'errMsg', 'stack', 'cause', 'originalError']) {
        try {
          const field = serialize((value as { [key: string]: unknown })[key], depth + 1)
          if (field !== undefined) result[key] = field
        } catch (_) { result[key] = '[unreadable]' }
      }
      return result
    }
    const entry = { clientAt: Date.now(), channel, retryDelayMs, ...subscriptionError(error), error: serialize(error, 0) }
    const stored: unknown = wx.getStorageSync(subscriptionErrorStorageKey)
    const entries = Array.isArray(stored) ? stored.slice(-29) : []
    entries.push(entry)
    wx.setStorageSync(subscriptionErrorStorageKey, entries)
    diagnostic('subscription_error_saved', { channel, storageKey: subscriptionErrorStorageKey })
  } catch (_) { /* Storage/serialization failure must not interrupt reconnection. */ }
}
