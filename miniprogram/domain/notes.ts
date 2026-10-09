import { NoteView, RoomView } from './types'

export const roleGuesses = ['未知', '偏好', '偏狼', '预言家', '女巫', '猎人', '守卫', '村民', '野孩子', '狼人', '白痴', '守墓人', '骑士', '白狼王', '狼王']
export interface NoteRow { seat: number; nickname: string; roleGuess: string; roleGuesses?: string[]; tone: string; sheriff: string; text: string; tendency: string; tags: string[] }
export function guessTone(guess: string) {
  if (['狼人', '白狼王', '狼王', '偏狼'].includes(guess)) return 'wolf'
  if (guess === '野孩子' || guess === '村民' || guess === '偏好') return 'civilian'
  return ['预言家', '女巫', '猎人', '守卫', '白痴', '守墓人', '骑士'].includes(guess) ? 'god' : 'unknown'
}
export function guessesFor(note: { roleGuesses?: string[]; roleGuess?: string; tendency?: string }): string[] {
  const source = Array.isArray(note.roleGuesses) ? note.roleGuesses : [note.roleGuess || note.tendency || '未知']
  return [...new Set(source.filter(role => roleGuesses.includes(role) && role !== '未知'))]
}
export function guessesTone(guesses: string[]) {
  const tones = [...new Set(guesses.map(guessTone))]
  return tones.length === 1 ? tones[0] : 'unknown'
}
export function noteRows(room: RoomView, notes: NoteView[]): NoteRow[] {
  return room.members.filter(member => member.seat > 0).sort((a, b) => a.seat - b.seat).map(member => {
    const note = notes.find(item => item.targetSeat === member.seat) || { targetSeat: member.seat, tendency: '未知', tags: [], text: '' }
    const guesses = guessesFor(note), roleGuess = guesses.join(' / ') || '未知'
    return { seat: member.seat, nickname: member.nickname, roleGuess, roleGuesses: guesses, tone: guessesTone(guesses), sheriff: note.tags.includes('上警') ? '上警' : note.tags.includes('警下') ? '警下' : '', text: note.text, tendency: note.tendency, tags: note.tags }
  })
}
export function rowNote(row: NoteRow): NoteView {
  return { kind: 'player', targetSeat: row.seat, roleGuess: guessesFor(row)[0] || '未知', roleGuesses: guessesFor(row), tendency: row.tendency, tags: row.tags, text: row.text }
}

// Count explicit guesses only; gods are also good players. No secret role data is read.
export function remainingGuesses(room: RoomView, rows: NoteRow[]) {
  let wolves = room.config.wolves, gods = room.config.gods, good = room.config.total - room.config.wolves
  const skills = new Set<string>()
  for (const row of rows) {
    for (const role of guessesFor(row)) {
      if (['偏好', '偏狼'].includes(role)) continue
      if (role !== '狼人' && role !== '村民') {
        if (skills.has(role)) continue
        skills.add(role)
      }
      const tone = guessTone(role)
      if (tone === 'wolf') wolves--
      if (tone === 'god') { gods--; good-- }
      if (tone === 'civilian') good--
    }
  }
  return { wolves: Math.max(0, wolves), gods: Math.max(0, gods), good: Math.max(0, good), excess: wolves < 0 || gods < 0 || good < 0 }
}
