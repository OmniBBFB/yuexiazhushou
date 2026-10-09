import { RoomView } from '../domain/types'
import { Announcement } from './announcer'

export function announcementFor(room: RoomView): { name: Announcement | ''; text: string; key: string } {
  const game = room.game
  if (!game) return { name: '', text: '', key: '' }
  const key = `${game.id}:${game.day}:${game.phase}:${game.nightStage}:${game.nightCue}`
  if (game.phase === 'DAY' && game.dayView && game.dayView.stage === 'NIGHT_RESULT') {
    return { name: `first-result:${game.publicResult.join(',')}`, text: game.dayView.resultText, key: `${key}:NIGHT_RESULT:${game.publicResult.join(',')}` }
  }
  if (game.phase === 'DAWN') return { name: 'dawn', text: '天亮了，请睁眼', key }
  if (game.phase !== 'NIGHT') return { name: '', text: '', key }
  if (game.nightCue === 'START') return { name: 'night', text: '天黑请闭眼', key }
  const roles: { [key: string]: { name: Announcement; label: string } } = { GRAVEKEEPER: { name: 'gravekeeper', label: '守墓人' }, WILD_CHILD: { name: 'wild-child', label: '野孩子' }, WEREWOLF: { name: 'werewolf', label: '狼人' }, SEER: { name: 'seer', label: '预言家' }, WITCH: { name: 'witch', label: '女巫' }, GUARD: { name: 'guard', label: '守卫' } }
  const role = roles[game.nightStage || '']
  if (!role) return { name: '', text: '夜间结果结算中', key }
  const cue = game.nightCue || 'ACTION'
  const suffix = cue === 'OPEN' ? '-open' : cue === 'CLOSE' ? '-close' : ''
  return { name: (role.name + suffix) as Announcement, text: role.label + (cue === 'OPEN' ? '请睁眼' : cue === 'CLOSE' ? '请闭眼' : (game.nightStage === 'WILD_CHILD' ? '请选择榜样' : game.nightStage === 'GRAVEKEEPER' ? '请查看守墓信息' : '请行动')), key }
}
