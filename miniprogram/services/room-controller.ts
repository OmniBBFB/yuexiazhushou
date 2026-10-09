import { RoomView } from '../domain/types'
import { identityGeneration, virtualUser } from './virtual-users'
import { watchRoom as watchSignal } from './room-sync'

// Lifecycle-owned refresh queue shared by every room consumer. At most one
// request runs, and a burst while fetching produces one trailing refresh.
export function watchRoom(refresh: () => Promise<unknown>, status: (connected: boolean) => void, current: () => RoomView | null, receive?: (room: RoomView | null) => void): () => void {
  const generation = identityGeneration()
  const direct = !!receive && !(typeof virtualUser === 'function' && virtualUser())
  let stopped = false, connected = false, fetching = false, pending = false, failures = 0
  let nextPollAt = Date.now() + 2000
  const run = async () => {
    if (stopped || generation !== identityGeneration()) return
    if (fetching) { pending = true; return }
    fetching = true
    try { failures = await refresh() === false ? failures + 1 : 0 }
    catch (_) { failures += 1 }
    finally {
      fetching = false
      const delay = failures ? Math.min(2000 * Math.pow(2, failures - 1), 30000) : connected ? 10000 : 2000
      nextPollAt = Date.now() + Math.round(delay * (failures || !connected ? 0.9 + Math.random() * 0.2 : 1))
      if (pending && !stopped) { pending = false; void run() }
    }
  }
  const close = watchSignal(() => { void run() }, value => {
    connected = value
    if (!connected) nextPollAt = Date.now()
    else if (!failures) nextPollAt = Date.now() + 10000
    status(value)
  }, current, receive)
  const poller = setInterval(() => { if (!(direct && connected) && Date.now() >= nextPollAt) void run() }, 1000)
  return () => { stopped = true; pending = false; close(); clearInterval(poller); status(false) }
}

export function serverOffset(room: RoomView, sentAt: number, receivedAt: number): number {
  return room.game && room.game.serverTime ? room.game.serverTime - (sentAt + receivedAt) / 2 : 0
}
