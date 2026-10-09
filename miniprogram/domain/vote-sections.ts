import { GameView, VoteHistoryView } from './types'
export function voteSections(game: GameView) {
  const all: VoteHistoryView[] = game.voteHistory || (game.dayView && game.dayView.voteResults || []).map(result => ({ ...result, day: game.day }))
  const newest = [...all].reverse(), stage = game.dayView && game.dayView.stage || ''
  const kind = stage.startsWith('SHERIFF') || stage === 'NIGHT_RESULT' ? 'SHERIFF' : stage.startsWith('EXILE') || stage === 'COMPLETE' || stage === 'DEATH_SKILL' ? 'EXILE' : ''
  const current = game.phase === 'DAY' ? newest.find(result => result.day === game.day && result.kind === kind) || null : null
  return { currentVote: current, previousVotes: newest.filter(result => result !== current), voteHistoryNewest: newest }
}
