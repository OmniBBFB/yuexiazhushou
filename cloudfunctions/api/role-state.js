function isWolf(role) { return !!role && (['狼人', '白狼王', '狼王'].includes(role.role) || role.role === '野孩子' && role.faction === 'WOLF') }
function faction(role) { return isWolf(role) ? 'WOLF' : 'VILLAGE' }
function transformationVisible(game, role) { return isWolf(role) && (role.role !== '野孩子' || game.phase === 'FINISHED' || game.day > Number(role.transformedDay || 0)) }
function transformWildChildren(game) {
  for (const role of Object.values(game.roles)) {
    if (role.role !== '野孩子' || !role.alive || isWolf(role) || !role.modelUserId) continue
    const model = game.roles[role.modelUserId]
    if (model && !model.alive) { role.faction = 'WOLF'; role.transformedDay = game.day }
  }
}
module.exports = { isWolf, faction, transformationVisible, transformWildChildren }
