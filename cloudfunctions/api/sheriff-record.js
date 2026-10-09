// Signup choices become public only once the signup stage ends.
function electionFor(game, room, signupComplete = false) {
  const state = game.dayState || {}
  if (game.sheriffElection) return game.sheriffElection
  if (!state.signup || !Object.keys(state.signup).length || state.stage === 'SHERIFF_SIGNUP' && !signupComplete) return null
  const signedSeats = room.members.filter(member => state.signup[member.userId] === true).map(member => member.seat).sort((a, b) => a - b)
  const withdrawnSeats = room.members.filter(member => (state.withdrawn || {})[member.userId]).map(member => member.seat).sort((a, b) => a - b)
  return { day: game.day, signedSeats, withdrawnSeats, candidateSeats: signedSeats.filter(seat => !withdrawnSeats.includes(seat)), completed: !!game.sheriffElectionDone, sheriffSeat: state.sheriffSeat || 0 }
}
module.exports = { electionFor }
