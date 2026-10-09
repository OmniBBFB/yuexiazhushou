import { Role, RoomConfig } from './types'

interface RoleRule { role: Role; count: number; description: string }
export interface RoomRulesView {
  settings: { label: string; value: string }[]
  winRule: string
  groups: { title: string; roles: RoleRule[] }[]
  common: string[]
}

// Rules describe the configured deck; never derive them from dealt identities.
const descriptions: Record<Role, string> = {
  '狼人': '每晚与存活狼队共同选择袭击目标，可以选择自己或队友。全部狼人提交后，超过半数选择同一目标才生效；未达成一致可以修改。白天可自爆终止流程，放逐投票、结果公布、死亡技能及白天结束阶段不能自爆。',
  '白狼王': '参与狼队互认与夜间袭击，查验和胜负均按狼人计算。白天自爆时选择另一名存活玩家一起出局，目标不能因被带走而开枪。自爆时机与普通狼人相同。首夜未公布结果时，先公布首夜情况，再进入下一阶段。',
  '狼王': '参与狼队互认与夜间袭击，按狼人阵营结算。被狼刀、放逐或开枪带走时可以开枪；被毒、白狼王带走、骑士决斗、自爆或手工标记出局时不能开枪。',
  '预言家': '每晚查验一名其他存活玩家，得知对方属于好人或狼人阵营，不能查验自己。结果仅本人可见，查看后确认结束行动。',
  '女巫': '整局各有一瓶解药和毒药，每晚最多使用一种，也可都不用。解药救治当晚狼刀目标，毒药选择一名存活玩家。解药不能抵消毒药；狼刀和毒药同时命中按毒杀处理。',
  '猎人': '被狼刀、放逐或开枪带走时，可以选择一名存活玩家开枪带走，也可放弃。被毒、白狼王带走、决斗或手工标记出局时不能开枪。',
  '守卫': '每晚守护一名存活玩家，可以守护自己，不能连续两晚守护同一人。守护挡住狼刀，不能挡住毒药；守护和解药同时命中仍然存活。',
  '白痴': '被放逐时自动翻牌存活，此后不能投票或再次被放逐，仍可以发言。如果持有警徽则警徽流失。狼刀、毒药、开枪等其他死亡方式正常生效，屠边时计入神职。',
  '守墓人': '每晚在守卫之后获知上一轮白天实际被放逐玩家的阵营，结果仅本人可见，查看后确认。首夜、无人放逐或白痴翻牌免死时显示无人放逐；可在查看身份中重新查看结果。',
  '骑士': '整局可决斗一次。在警长竞选及首夜结果确认后，决定发言顺序或正常白天发言时选择其他存活玩家。目标是狼人则目标出局并结束白天；目标是好人则骑士出局、白天继续。放逐投票及 PK 阶段不能决斗。被决斗的狼王不能开枪。',
  '村民': '没有主动技能，通过发言与投票寻找狼人，与好人阵营共同获胜。',
  '野孩子': '占用一个平民名额，首夜选择另一名存活玩家作为榜样，确认后不能修改。榜样出局后不可逆地转为狼人，从下一夜加入狼队、互认并参与袭击。未转化时属于好人、计入平民；转化后按狼人阵营结算，没有独立第三方胜利条件。',
}

export function rulesForRoom(config: RoomConfig): RoomRulesView {
  const specialWolves = config.wolfRoles || []
  const legacyGods: { [total: number]: Role[] } = { 6: ['预言家', '女巫'], 9: ['预言家', '女巫', '猎人'], 12: ['预言家', '女巫', '猎人', '守卫'] }
  const gods: Role[] = config.godRoles || legacyGods[config.total] || []
  const row = (role: Role, count = 1): RoleRule => ({ role, count, description: descriptions[role] })
  const ordinaryWolves = Math.max(0, config.wolves - specialWolves.length)
  const villagers = Math.max(0, config.villagers - (config.wildChild ? 1 : 0))
  const groups = [
    { title: '狼人', roles: [...(ordinaryWolves ? [row('狼人', ordinaryWolves)] : []), ...specialWolves.map(role => row(role))] },
    { title: '神职', roles: gods.map(role => row(role)) },
    { title: '平民与特殊角色', roles: [...(villagers ? [row('村民', villagers)] : []), ...(config.wildChild ? [row('野孩子')] : [])] },
  ].filter(group => group.roles.length)
  return {
    settings: [
      { label: '人数', value: `${config.total} 人` },
      { label: '阵容名额', value: `狼 ${config.wolves} · 神 ${config.gods} · 平民 ${config.villagers}` },
      { label: '胜利方式', value: config.winMode },
      { label: '播报间隔', value: `${config.interval} 秒` },
    ],
    winRule: '无存活狼人时，好人阵营获胜；存活狼人数量达到或超过存活好人数时，狼人阵营获胜。' + (config.winMode === '屠边' ? '屠边还包含：神职或平民任一类全部出局，狼人阵营获胜。' : '屠城不额外按神职或平民单类出局判胜。'),
    groups,
    common: [
      '首夜死亡结果在警长竞选结束后公布；结果公布前仍按公开存活状态参与确认和竞选。第二夜起在黎明公布结果。',
      '警长投票权重为 1.5 票。首次平票进入 PK，第二次仍平票时，警长竞选警徽流失，放逐投票无人出局。',
      '猎人和狼王开枪按座位依次处理，每人有 90 秒选择目标或放弃，超时自动放弃；连锁开枪全部结束后再判断胜负。',
    ],
  }
}
