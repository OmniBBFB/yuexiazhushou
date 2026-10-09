import { diagnostic } from './telemetry'
import { api } from '../api/client'
import { NoteView } from '../domain/types'
import { identityGeneration } from './virtual-users'
import { backendDatabase } from './backend'

export function watchNotes(gameId: string, receive: (notes: NoteView[]) => void): () => void {
  const generation = identityGeneration()
  let stopped = false, watcher: { close: () => Promise<void> } | null = null
  let retry: ReturnType<typeof setTimeout> | null = null, delay = 1000
  const connect = async () => {
    try {
      const identity = await api.syncIdentity()
      if (stopped || generation !== identityGeneration() || identity.virtual) return
      watcher = backendDatabase().collection('notes').where({ _openid: identity.openid, ownerId: identity.userId, gameId }).watch({
        onChange: snapshot => {
          if (stopped || generation !== identityGeneration()) return
          delay = 1000
          diagnostic('notes_received', { gameId, records: snapshot.docs.length })
          receive(snapshot.docs as NoteView[])
        }, onError: reconnect,
      })
    } catch (_) { reconnect() }
  }
  const reconnect = () => {
    if (stopped || generation !== identityGeneration()) return
    if (watcher) { watcher.close().catch(() => undefined); watcher = null }
    if (retry) clearTimeout(retry)
    retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 30000)
  }
  void connect()
  return () => { stopped = true; if (retry) clearTimeout(retry); if (watcher) watcher.close().catch(() => undefined) }
}
