const GOD_ROLES = ['预言家', '女巫', '猎人', '守卫', '白痴', '守墓人', '骑士']
const WOLF_ROLES = ['白狼王', '狼王']
const LEGACY_GODS = { 6: GOD_ROLES.slice(0, 2), 9: GOD_ROLES.slice(0, 3), 12: GOD_ROLES.slice(0, 4) }

function normalizeConfig(input) {
  const reject = message => { const error = new Error(message); error.code = 'BAD_CONFIG'; throw error }
  if (!input || !Number.isInteger(input.total) || input.total < 6 || input.total > 16) reject('人数需为 6–16 人')
  const godRoles = input.godRoles === undefined ? LEGACY_GODS[input.total] : input.godRoles
  if (!Array.isArray(godRoles) || !godRoles.length || godRoles.some(role => !GOD_ROLES.includes(role)) || new Set(godRoles).size !== godRoles.length) reject('请选择至少一种神职，每种神职最多一人')
  if (!Number.isInteger(input.wolves) || input.wolves < 1 || input.wolves * 2 >= input.total) reject('至少一名狼人，且狼人须少于总人数的一半')
  if (!Number.isInteger(input.villagers) || input.villagers < 1) reject('至少保留一名村民')
  if (input.gods !== godRoles.length || input.wolves + input.villagers + godRoles.length !== input.total) reject('狼、神、民人数之和必须等于总人数')
  if (!['屠边', '屠城'].includes(input.winMode)) reject('胜利方式无效')
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 6) reject('播报间隔需为 1–6 秒')
  if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 8)) reject('房间密码最多 8 位')
  if (input.wildChild !== undefined && typeof input.wildChild !== 'boolean') reject('野孩子配置无效')
  const wolfRoles = input.wolfRoles === undefined ? [] : input.wolfRoles
  if (!Array.isArray(wolfRoles) || wolfRoles.some(role => !WOLF_ROLES.includes(role)) || new Set(wolfRoles).size !== wolfRoles.length || wolfRoles.length > input.wolves) reject('特殊狼人每种最多一人，且不能超过狼人名额')
  return { total: input.total, wolves: input.wolves, gods: godRoles.length, villagers: input.villagers, godRoles: GOD_ROLES.filter(role => godRoles.includes(role)), winMode: input.winMode, interval: input.interval, ...(input.wildChild ? { wildChild: true } : {}), ...(wolfRoles.length ? { wolfRoles: WOLF_ROLES.filter(role => wolfRoles.includes(role)) } : {}) }
}

function buildRoles(config) {
  const board = normalizeConfig(config)
  return [...Array(board.wolves - (board.wolfRoles || []).length).fill('狼人'), ...(board.wolfRoles || []), ...board.godRoles, ...(board.wildChild ? ['野孩子'] : []), ...Array(board.villagers - (board.wildChild ? 1 : 0)).fill('村民')]
}

module.exports = { normalizeConfig, buildRoles }
