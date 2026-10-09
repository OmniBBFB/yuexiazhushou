import { backendConfig } from '../config/backend'
import { diagnostic } from './telemetry'
import { virtualUser } from './virtual-users'

interface LocalResponse {
  ok?: boolean
  token?: string
  error?: { code: string; message: string }
  docs?: { _id: string; [field: string]: unknown }[] | null
  cursor?: string
  timing?: { [field: string]: string | number | boolean | undefined }
}
let login: Promise<string> | null = null

function localRequest(path: string, data: object, token = '', onTask?: (task: WechatMiniprogram.RequestTask) => void): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const trace = data as { traceId?: string; action?: string }
    const failed = (error: unknown, statusCode?: number) => {
      const value = error as { message?: string; errMsg?: string; code?: string }
      const message = String(value?.message || value?.errMsg || '本地请求失败').slice(0, 500)
      const code = value?.code || 'LOCAL_TRANSPORT_ERROR'
      diagnostic('local_transport_error', { path, action: trace.action, requestId: trace.traceId, errorCode: code, statusCode, message })
      reject(Object.assign(new Error(message), { code, statusCode }))
    }
    const task = wx.request({
      url: backendConfig.local.baseUrl.replace(/\/$/, '') + path,
      method: 'POST', data, timeout: path === '/watch' ? 35000 : 60000,
      header: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      success: response => {
        const result = response.data as LocalResponse
        if (response.statusCode < 200 || response.statusCode >= 300) {
          failed({ message: result?.error?.message || `本地接口错误 ${response.statusCode}`, code: result?.error?.code }, response.statusCode)
        } else if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
          failed({ message: '本地接口返回格式无效', code: 'LOCAL_RESPONSE_INVALID' }, response.statusCode)
        } else resolve(result)
      }, fail: error => failed(error),
    })
    if (onTask) onTask(task)
  })
}
function localToken() {
  if (!login) {
    const attempt = localRequest('/session', { accessKey: backendConfig.local.accessKey, clientId: backendConfig.local.clientId }).then(result => {
      if (!result.ok || !result.token) throw new Error('本地登录失败')
      return result.token
    })
    login = attempt
    void attempt.catch(() => { if (login === attempt) login = null })
  }
  return login
}
async function authorizedRequest(path: string, data: object, onTask?: (task: WechatMiniprogram.RequestTask) => void) {
  const token = await localToken()
  try { return await localRequest(path, data, token, onTask) }
  catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 401) throw error
    // Server restart/token expiry: retry with fresh development credentials once.
    if (login && await login === token) login = null
    return localRequest(path, data, await localToken(), onTask)
  }
}

export function callBackend(data: object): Promise<{ result: unknown }> {
  if (backendConfig.mode === 'cloud') return wx.cloud.callFunction({ name: 'api', data })
  return authorizedRequest('/api', data).then(result => {
    if (result.timing) diagnostic('local_backend_timing', result.timing)
    return { result }
  })
}

// A watch-compatible adapter keeps the existing public/private merge and retry logic.
// Empty heartbeats renew the long poll; they never query the game API.
function watchLocal(collection: string, query: object, options: {
  onChange: (snapshot: { docs: { _id: string; [field: string]: unknown }[] }) => void
  onError: (error: unknown) => void
}) {
  let stopped = false, cursor = ''
  let task: WechatMiniprogram.RequestTask | null = null
  const testUser = virtualUser()
  const track = (value: WechatMiniprogram.RequestTask) => { task = value; if (stopped) value.abort() }
  void (async () => {
    while (!stopped) {
      try {
        // Check again after login, because the page/identity can change meanwhile.
        await localToken()
        if (stopped) return
        const result = await authorizedRequest('/watch', { collection, query, cursor, ...(testUser ? { testUser } : {}) }, track)
        if (stopped) return
        if (!result.ok) throw new Error(result.error?.message || '本地订阅失败')
        cursor = result.cursor || ''
        if (result.docs) options.onChange({ docs: result.docs })
      } catch (error) { if (!stopped) { stopped = true; options.onError(error) } }
    }
  })()
  return { async close() { stopped = true; if (task) task.abort() } }
}
export function backendDatabase(): ReturnType<typeof wx.cloud.database> {
  if (backendConfig.mode === 'cloud') return wx.cloud.database()
  // Local supports only the read-only watcher surface used by room/notes sync.
  return {
    command: { in: (values: string[]) => ({ $in: values }) },
    collection: (name: string) => ({ where: (query: object) => ({ watch: (options: Parameters<typeof watchLocal>[2]) => watchLocal(name, query, options) }) }),
  } as unknown as ReturnType<typeof wx.cloud.database>
}
