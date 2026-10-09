const { transactionStore, assertResult } = require('./repository')
function createAuth({ db, crypto, fail, virtualNickname }) {
async function getUser(openid, testScope = '', authOpenid = openid) {
  if (typeof openid !== 'string' || !openid.trim()) fail('UNAUTHENTICATED', '无法识别微信账号，请从微信重新打开小程序')
  const found = assertResult(await db.collection('users').where({ openid }).limit(1).get())
  if (found.data[0]) {
    const existing = found.data[0]
    if ((existing.testScope || '') !== testScope) fail('IDENTITY_MISMATCH', '账号的测试身份不一致，请检查测试数据')
    const update = {}
    if (existing.authOpenid !== authOpenid) { existing.authOpenid = authOpenid; update.authOpenid = authOpenid }
    if (testScope && /^玩家\d{4}$/.test(existing.nickname)) {
      existing.nickname = virtualNickname(openid, testScope)
      update.nickname = existing.nickname
    }
    if (Object.keys(update).length) assertResult(await db.collection('users').doc(existing._id).update({ data: update }))
    return existing
  }
  const suffix = crypto.randomInt(1000, 10000)
  const user = { openid, authOpenid, testScope, nickname: virtualNickname(openid, testScope) || `玩家${suffix}`, gender: '保密', avatar: '', currentRoomId: '', createdAt: db.serverDate(), updatedAt: db.serverDate() }
  const userId = crypto.createHash('sha256').update(openid).digest('hex')
  return db.runTransaction(async transaction => {
    const store = transactionStore(transaction, db)
    const ref = store.collection('users').doc(userId)
    const existing = (await ref.get()).data
    if (existing) {
      if (existing.openid !== openid || (existing.testScope || '') !== testScope) fail('IDENTITY_MISMATCH', '账号身份不一致')
      return existing
    }
    await ref.set({ data: user })
    await store.flush()
    return { ...user, _id: userId }
  })
}
return { getUser }
}
module.exports = { createAuth }
