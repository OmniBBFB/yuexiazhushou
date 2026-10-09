const GUESSES = ['未知', '偏好', '偏狼', '狼人', '预言家', '女巫', '猎人', '守卫', '村民', '野孩子', '白痴', '守墓人', '骑士', '白狼王', '狼王']

function guessesFor(note) {
  const source = Array.isArray(note.roleGuesses) ? note.roleGuesses : [note.roleGuess || note.tendency || '未知']
  return [...new Set(source.filter(role => GUESSES.includes(role) && role !== '未知'))]
}
function normalizeNote(note, members) {
  const targetSeat = Number(note.targetSeat)
  if (note.kind === 'relations') {
    const fail = () => { throw Object.assign(new Error('关系图数据无效'), { code: 'BAD_NOTES' }) }
    if (targetSeat !== -1 || !Array.isArray(note.edges) || note.edges.length > 240) fail()
    const seats = new Set(members.filter(item => item.seat > 0).map(item => item.seat)), pairs = new Set()
    const edges = note.edges.map(edge => {
      if (!edge || !Number.isInteger(edge.source) || !Number.isInteger(edge.target) || edge.source === edge.target || !seats.has(edge.source) || !seats.has(edge.target) || !['ATTACK', 'SUPPORT'].includes(edge.type)) fail()
      const key = `${edge.source}:${edge.target}`
      if (pairs.has(key)) fail()
      pairs.add(key)
      return { source: edge.source, target: edge.target, type: edge.type }
    })
    return { kind: 'relations', targetSeat: -1, tendency: '未知', tags: [], text: '', edges }
  }
  const summary = note.kind === 'summary' && targetSeat === 0
  if (!summary && (!Number.isInteger(targetSeat) || targetSeat < 1 || !members.some(item => item.seat === targetSeat))) {
    const error = new Error('座位不存在'); error.code = 'BAD_TARGET'; throw error
  }
  if (summary) return { kind: 'summary', targetSeat: 0, tendency: '未知', tags: [], text: '', freeText: String(note.freeText || '').slice(0, 1000), voteText: String(note.voteText || '').slice(0, 1000) }
  return { kind: 'player', targetSeat, tendency: ['未知', '偏好', '偏狼'].includes(note.tendency) ? note.tendency : '未知',
    roleGuess: guessesFor(note)[0] || '未知', roleGuesses: guessesFor(note),
    tags: [...new Set(Array.isArray(note.tags) ? note.tags.filter(tag => typeof tag === 'string').map(tag => tag.slice(0, 16)) : [])].slice(0, 8),
    text: String(note.text || '').slice(0, 300) }
}

function noteView(note) {
  if (note.kind === 'relations') return { revision: Number(note.revision || 0), kind: 'relations', targetSeat: -1, tendency: '未知', tags: [], text: '', edges: note.edges || [] }
  return { revision: Number(note.revision || 0), kind: note.kind || 'player', targetSeat: note.targetSeat, tendency: note.tendency || '未知', roleGuess: guessesFor(note)[0] || '未知', roleGuesses: guessesFor(note), tags: note.tags || [], text: note.text || '', freeText: note.freeText || '', voteText: note.voteText || '' }
}

module.exports = { normalizeNote, noteView }
