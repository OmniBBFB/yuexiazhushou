// macOS: regenerate bundled public-result clips without any runtime TTS dependency.
const { execFileSync } = require('node:child_process')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const temp = mkdtempSync(path.join(tmpdir(), 'night-result-audio-'))
const gravekeeper = process.argv.includes('--gravekeeper')
const clips = gravekeeper ? [['gravekeeper-open', '守墓人请睁眼'], ['gravekeeper', '守墓人请查看守墓信息'], ['gravekeeper-close', '守墓人请闭眼']] : process.argv.includes('--wild-child')
  ? [['wild-child-open', '野孩子请睁眼'], ['wild-child', '野孩子请选择榜样'], ['wild-child-close', '野孩子请闭眼']]
  : [['first-night-result', '首夜情况'], ['peaceful-night', '首夜是一个平安夜'], ['left-game', '离场']]
if (!gravekeeper && !process.argv.includes('--wild-child')) for (let seat = 1; seat <= 16; seat++) clips.push([`seat-${seat}`, `${seat}号玩家`])
for (const [name, text] of clips) {
  const input = path.join(temp, `${name}.aiff`)
  execFileSync('/usr/bin/say', ['-v', 'Tingting', '-r', '200', '-o', input, text])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-codec:a', 'libmp3lame', '-b:a', '48k', path.join(__dirname, '../miniprogram/assets/audio', `${name}.mp3`)])
}
console.log(`Generated ${clips.length} public-result clips.`)
