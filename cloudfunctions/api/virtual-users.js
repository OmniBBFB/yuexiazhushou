const crypto = require('crypto')
const SLOTS = ['host', ...Array.from({ length: 15 }, (_, i) => `player-${i + 1}`)]
function resolveIdentity(openid, slot, env = process.env) {
  if (typeof openid !== 'string' || !openid.trim()) throw Object.assign(new Error('无法识别微信账号'), { code: 'UNAUTHENTICATED' })
  if (slot === undefined || slot === '') return { openid, testScope: '' }
  const allowed = String(env.VIRTUAL_TEST_OPENIDS || '').split(',').map(value => value.trim()).filter(Boolean)
  if (env.VIRTUAL_TEST_ENABLED !== 'true' || !allowed.includes(openid)) throw Object.assign(new Error('虚拟用户未启用，或当前微信账号不在测试白名单中'), { code: 'TEST_FORBIDDEN' })
  if (!SLOTS.includes(slot)) throw Object.assign(new Error('虚拟用户编号无效'), { code: 'BAD_TEST_USER' })
  const scope = crypto.createHash('sha256').update(openid).digest('hex')
  return { openid: `virtual:${scope}:${slot}`, testScope: scope }
}
function assertScope(room, user) {
  if ((room.testScope || '') !== (user.testScope || '')) throw Object.assign(new Error('测试房间与真实房间不能互相加入'), { code: 'TEST_ROOM_ISOLATED' })
}
function virtualNickname(openid, testScope) {
  if (!testScope) return ''
  const slot = openid.split(':').pop()
  return slot === 'host' ? '虚拟房主' : `虚拟玩家${slot.slice(7)}`
}
function notificationOpenid(user, callerOpenid) {
  if (!user.openid.startsWith('virtual:')) return user.openid
  const scope = user.openid.split(':')[1]
  const owner = user.authOpenid && !user.authOpenid.startsWith('virtual:') ? user.authOpenid : callerOpenid
  if (!owner || crypto.createHash('sha256').update(owner).digest('hex') !== scope) {
    throw Object.assign(new Error('无法确认测试通知的授权账号'), { code: 'IDENTITY_MISMATCH' })
  }
  return owner
}
module.exports = { resolveIdentity, assertScope, virtualNickname, notificationOpenid }
