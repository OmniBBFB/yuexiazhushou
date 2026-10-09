import { beginOperation, finishRequest, resetDiagnostics } from '../services/telemetry'
import { callBackend } from '../services/backend'
import { NoteView, RoomConfig, RoomView, SessionView } from '../domain/types'
import { identityGeneration, virtualUser } from '../services/virtual-users'

export interface CommandAck { accepted: true; requestId: string; roomId: string; version: number }

interface ApiResult<T> { ok: boolean; data?: T; identity?: { testUser: string; protocol: number }; error?: { code: string; message: string } }

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ApiError' }
}
const subscribedCommands = new Set(["selectSeat", "rotateSeats", "readyVirtualPlayers", "setReady", "addBots", "startGame", "confirmRole", "submitNightAction", "suggestWolfTarget", "confirmDawn", "updateAlive", "sheriffSignup", "sheriffVote", "confirmFirstNightResult", "setSpeechOrder", "finishSpeech", "extendSpeech", "withdrawSheriff", "exileVote", "wolfExplode", "shoot", "knightDuel", "nextNight", "finishGame", "nextGame"])
let traceGeneration = -1
const inFlight = new Map<string, { payload: string; promise: Promise<unknown> }>()
const queries = new Set(['session', 'getRoom', 'syncIdentity', 'subscribeRoom', 'listNotes', 'heartbeatBroadcast', 'releaseBroadcast'])
function call<T>(action: string, payload: object = {}, startedAt = Date.now()): Promise<T> {
  const generation = identityGeneration()
  if (generation !== traceGeneration) { resetDiagnostics(); traceGeneration = generation }
  if (queries.has(action)) return request<T>(action, payload)
  const key = `${identityGeneration()}:${action}`
  const previous = inFlight.get(key)
  if (previous) return previous.payload === JSON.stringify(payload) ? previous.promise as Promise<T> : Promise.reject(new ApiError('REQUEST_BUSY', '上一操作尚未完成，请稍后重试'))
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`
  beginOperation(action, requestId, startedAt)
  const pending = request<T>(action, { ...payload, requestId }).finally(() => {
    const current = inFlight.get(key)
    if (current && current.promise === pending) inFlight.delete(key)
  })
  inFlight.set(key, { payload: JSON.stringify(payload), promise: pending })
  return pending
}
function request<T>(action: string, payload: object): Promise<T> {
  const generation = identityGeneration(), testUser = virtualUser(), sentAt = Date.now()
  const requestId = (payload as { requestId?: string }).requestId || `trace_${sentAt}_${Math.random().toString(36).slice(2)}`
  return callBackend({ action, payload, traceId: requestId, ...(subscribedCommands.has(action) ? { delivery: 'subscription' } : {}), ...(testUser ? { testUser } : {}) }).then(res => {
    if (generation !== identityGeneration()) throw new Error('测试用户已切换，请重新操作')
    const result = res.result as ApiResult<T>
    if (result && !result.ok && result.error && result.error.code === 'UNKNOWN_ACTION') {
      throw new Error('云端 api 版本过旧，请上传并部署最新云函数后重试')
    }
    if (!result || !result.ok || result.data === undefined) throw new ApiError(result && result.error ? result.error.code : 'INVALID_RESPONSE', result && result.error ? result.error.message : '服务暂时不可用')
    if (testUser && (!result.identity || result.identity.protocol !== 1 || result.identity.testUser !== testUser)) {
      throw new Error('云函数未确认虚拟身份，请部署最新 api 后重试')
    }
    const ack = result.data as unknown as CommandAck
    finishRequest(action, requestId, sentAt, undefined, ack && ack.accepted && ack.roomId ? ack : undefined)
    return result.data
  }).catch(error => {
    finishRequest(action, requestId, sentAt, error instanceof ApiError ? error.code : 'TRANSPORT_OR_IDENTITY_ERROR')
    throw error
  })
}

export const api = {
  syncIdentity: () => call<{ userId: string; openid: string; virtual?: boolean }>('syncIdentity'),
  transferBroadcast: (userId: string, broadcastVersion: number) => call('transferBroadcast', { userId, broadcastVersion }),
  heartbeatBroadcast: (sessionId: string) => call<{ granted: boolean; leaseMs: number; version?: number }>('heartbeatBroadcast', { sessionId }),
  releaseBroadcast: (sessionId: string) => call('releaseBroadcast', { sessionId }),
  session: () => call<SessionView>('session'),
  updateProfile: (nickname: string, gender: string) => call<SessionView>('updateProfile', { nickname, gender }),
  createRoom: (config: RoomConfig) => call<RoomView>('createRoom', { config }),
  joinRoom: (code: string, password: string) => call<RoomView>('joinRoom', { code, password }),
  exitRoom: () => call<SessionView>('exitRoom'),
  leaveRoom: () => call<SessionView>('exitRoom'),
  dissolveRoom: () => call<SessionView>('dissolveRoom'),
  forceLeaveRoom: () => call<SessionView>('exitRoom'),
  selectSeat: (seat: number, version: number, startedAt?: number) => call<CommandAck>('selectSeat', { seat, version }, startedAt),
  rotateSeats: (version: number) => call<CommandAck>('rotateSeats', { version }),
  readyVirtualPlayers: (version: number) => call<CommandAck>('readyVirtualPlayers', { version }),
  setReady: (ready: boolean, version: number) => call<CommandAck>('setReady', { ready, version }),
  addBots: (version: number) => call<CommandAck>('addBots', { version }),
  startGame: (version: number) => call<CommandAck>('startGame', { version }),
  getRoom: () => call<RoomView>('getRoom'),
  subscribeRoom: () => call<RoomView | null>('subscribeRoom'),
  confirmRole: (version: number) => call<CommandAck>('confirmRole', { version }),
  submitNightAction: (payload: object) => call<CommandAck>('submitNightAction', payload),
  suggestWolfTarget: (targetSeat: number, version: number) => call<CommandAck>('suggestWolfTarget', { targetSeat, version }),
  confirmDawn: (version: number) => call<CommandAck>('confirmDawn', { version }),
  updateAlive: (seat: number, alive: boolean, version: number) => call<CommandAck>('updateAlive', { seat, alive, version }),
  sheriffSignup: (join: boolean, version: number) => call<CommandAck>('sheriffSignup', { join, version }),
  sheriffVote: (targetSeat: number, version: number) => call<CommandAck>('sheriffVote', { targetSeat, version }),
  confirmFirstNightResult: (version: number) => call<CommandAck>('confirmFirstNightResult', { version }),
  setSpeechOrder: (direction: 'ASC' | 'DESC', version: number) => call<CommandAck>('setSpeechOrder', { direction, version }),
  finishSpeech: (version: number) => call<CommandAck>('finishSpeech', { version }),
  extendSpeech: (version: number) => call<CommandAck>('extendSpeech', { version }),
  withdrawSheriff: (version: number) => call<CommandAck>('withdrawSheriff', { version }),
  exileVote: (targetSeat: number, version: number) => call<CommandAck>('exileVote', { targetSeat, version }),
  wolfExplode: (version: number, targetSeat = 0) => call<CommandAck>('wolfExplode', { version, targetSeat }),
  shoot: (targetSeat: number, version: number) => call<CommandAck>('shoot', { targetSeat, version }),
  knightDuel: (targetSeat: number, version: number) => call<CommandAck>('knightDuel', { targetSeat, version }),
  nextNight: (version: number) => call<CommandAck>('nextNight', { version }),
  finishGame: (version: number) => call<CommandAck>('finishGame', { version }),
  nextGame: (version: number) => call<CommandAck>('nextGame', { version }),
  listNotes: (gameId?: string) => call<NoteView[]>('listNotes', { gameId }),
  saveNotes: (notes: NoteView[], gameId: string) => call<NoteView[]>('saveNotes', { notes, gameId }),
  saveNote: (note: NoteView, gameId?: string) => call<NoteView>('saveNote', { note, gameId }),
}

export function showError(error: unknown) {
  wx.showToast({ title: error instanceof Error ? error.message : '操作失败，请重试', icon: 'none' })
}
