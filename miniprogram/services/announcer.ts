type NightRole = 'werewolf' | 'seer' | 'witch' | 'guard' | 'wild-child' | 'gravekeeper'
export type Announcement = 'night' | NightRole | `${NightRole}-open` | `${NightRole}-close` | 'dawn' | `first-result:${string}`

const sources: { [key: string]: string } = {
  night: '/assets/audio/night.mp3',
  werewolf: '/assets/audio/werewolf.mp3',
  seer: '/assets/audio/seer.mp3',
  witch: '/assets/audio/witch.mp3',
  guard: '/assets/audio/guard.mp3',
  'wild-child': '/assets/audio/wild-child.mp3',
  'wild-child-open': '/assets/audio/wild-child-open.mp3',
  'wild-child-close': '/assets/audio/wild-child-close.mp3',
  gravekeeper: '/assets/audio/gravekeeper.mp3',
  'gravekeeper-open': '/assets/audio/gravekeeper-open.mp3',
  'gravekeeper-close': '/assets/audio/gravekeeper-close.mp3',
  dawn: '/assets/audio/dawn.mp3',
  'werewolf-open': '/assets/audio/werewolf-open.mp3',
  'werewolf-close': '/assets/audio/werewolf-close.mp3',
  'seer-open': '/assets/audio/seer-open.mp3',
  'seer-close': '/assets/audio/seer-close.mp3',
  'witch-open': '/assets/audio/witch-open.mp3',
  'witch-close': '/assets/audio/witch-close.mp3',
  'guard-open': '/assets/audio/guard-open.mp3',
  'guard-close': '/assets/audio/guard-close.mp3',
}

let audio: WechatMiniprogram.InnerAudioContext | null = null
let queue: string[] = []

function resultSources(name: Announcement) {
  if (!name.startsWith('first-result:')) return [sources[name]]
  const seats = name.slice('first-result:'.length).split(',').filter(Boolean).map(Number).filter(seat => Number.isInteger(seat) && seat >= 1 && seat <= 16)
  if (!seats.length) return ['/assets/audio/peaceful-night.mp3']
  return ['/assets/audio/first-night-result.mp3', ...seats.map(seat => `/assets/audio/seat-${seat}.mp3`), '/assets/audio/left-game.mp3']
}
function playNext() {
  const source = queue.shift()
  if (!audio || !source) return
  audio.src = source; audio.play()
}

export function playAnnouncement(name: Announcement) {
  if (!audio) {
    audio = wx.createInnerAudioContext()
    audio.obeyMuteSwitch = false
    audio.onEnded(playNext)
    audio.onError(() => { queue = []; wx.showToast({ title: '语音播放失败，请查看文字提示', icon: 'none' }) })
  }
  audio.stop()
  queue = resultSources(name)
  playNext()
}

export function stopAnnouncement() {
  queue = []
  if (audio) audio.stop()
}
