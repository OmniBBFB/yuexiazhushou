async function advanceDue(db, advance, now = Date.now(), logger = console) {
  const tasks = (await db.collection('game_tasks').where({ dueAt: db.command.lt(now + 1) }).limit(100).get()).data
  const result = { advanced: 0, failed: 0 }
  for (const task of tasks) {
    try { await advance(task.roomId); result.advanced++ }
    catch (error) { result.failed++; logger.error('advance failed', { roomId: task.roomId, message: error.message }) }
  }
  if (tasks.length) logger.info('game task metrics', { selected: tasks.length, ...result })
  return result
}
module.exports = { advanceDue }
