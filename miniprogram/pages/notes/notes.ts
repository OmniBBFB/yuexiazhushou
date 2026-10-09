import { setChangedData } from '../../services/page-data'
import { api, ApiError, showError } from '../../api/client'
import { NoteRow, guessTone, noteRows, roleGuesses, rowNote, remainingGuesses, guessesFor, guessesTone } from '../../domain/notes'
import { NoteView, RoomView } from '../../domain/types'
import { announcementFor } from '../../services/announcements'
import { startBroadcast, stopBroadcast, syncBroadcast } from '../../services/broadcast'
import { watchNotes } from '../../services/notes-sync'
import { watchRoom } from '../../services/room-controller'

interface NoteDraft { gameId: string; notes: NoteView[] }
Page({
  data: { remaining: { wolves: 0, gods: 0, good: 0, excess: false }, rows: [] as NoteRow[], freeText: '', voteText: '', loading: true, saveStatus: '正在加载', selectedSeat: 0, roleSheetOpen: false,
    roleOptions: roleGuesses.map(role => ({ role, tone: guessTone(role), selected: false })), room: null as RoomView | null },
  openingGraph: false, visible: false, returningToGame: false, epoch: 0, fetching: false, myId: '', gameId: '', loadedGameId: '', draftKey: '', revision: 0,
  cloudRevisions: {} as { [seat: string]: number }, noteConflict: false, draftTimer: 0 as number, pendingSnapshot: undefined as RoomView | null | undefined, pendingRefresh: false,
  dirty: {} as { [seat: string]: number }, queue: Promise.resolve(), saveTimer: 0 as number, poller: 0 as number, heartbeat: 0 as number, deadline: 0 as number,
  stopNotes: (() => {}) as () => void,
  lastFetch: 0, syncConnected: false, stopSync: (() => {}) as () => void,
  async onShow() {
    this.openingGraph = false; this.visible = true; this.returningToGame = false; this.epoch += 1; this.fetching = false; this.pendingRefresh = false; this.pendingSnapshot = undefined; this.myId = ''; this.loadedGameId = ''; startBroadcast()
    await this.load(true)
    if (!this.visible) return
    this.stopSync = watchRoom(() => this.load(false), connected => { this.syncConnected = connected }, () => this.data.room, room => { void this.load(false, room) })
    
    this.heartbeat = setInterval(() => this.announce(), 3000) as unknown as number
  },
  onHide() { if (!this.visible) return; this.visible = false; this.epoch += 1; this.stopSync(); this.stopNotes(); this.syncConnected = false; clearInterval(this.poller); clearInterval(this.heartbeat); clearTimeout(this.deadline); clearTimeout(this.saveTimer); this.writeDraft(); this.saveAll(); if (!this.returningToGame && !this.openingGraph) stopBroadcast() },
  onUnload() { this.onHide() },
  async load(showFailure: boolean, snapshot?: RoomView | null): Promise<boolean | void> {
    if (!this.visible) return
    if (this.fetching) { this.pendingRefresh = true; if (snapshot !== undefined) this.pendingSnapshot = snapshot; return }
    const epoch = this.epoch; this.fetching = true
    try {
      const knownId = this.myId
      const session = snapshot !== undefined ? { profile: { id: knownId }, room: snapshot } : knownId ? { profile: { id: knownId }, room: await api.getRoom() } : await api.session()
      if (!this.visible || epoch !== this.epoch) return
      const room = session.room
      if (!room || !room.game) { wx.navigateBack(); return }
      this.myId = session.profile.id
      setChangedData(this, { room }); this.lastFetch = Date.now(); this.announce()
      const game = room.game
      if (this.loadedGameId !== game.id) {
        this.stopNotes()
        const notes = await api.listNotes(game.id)
        if (!this.visible || epoch !== this.epoch) return
        this.gameId = game.id; this.loadedGameId = game.id; this.draftKey = `night-notes:${this.myId}:${game.id}`
        this.dirty = {}; this.cloudRevisions = {}; this.noteConflict = false
        for (const note of notes) this.cloudRevisions[String(note.targetSeat)] = note.revision || 0
        const draft = wx.getStorageSync(this.draftKey) as NoteDraft | undefined
        if (draft && draft.gameId === game.id && Array.isArray(draft.notes)) {
          for (const pending of draft.notes) {
            const index = notes.findIndex(note => note.targetSeat === pending.targetSeat)
            if (index < 0) notes.push(pending); else notes[index] = pending
            this.cloudRevisions[String(pending.targetSeat)] = pending.revision || 0
            this.dirty[String(pending.targetSeat)] = ++this.revision
          }
        }
        const summary = notes.find(note => note.kind === 'summary')
        this.setData({ rows: noteRows(room, notes), freeText: summary ? summary.freeText || '' : '', voteText: summary ? summary.voteText || '' : '', loading: false, saveStatus: Object.keys(this.dirty).length ? '有待保存的记录' : '已保存 · 仅自己可见' })
        if (Object.keys(this.dirty).length) this.saveAll()
        this.stopNotes = watchNotes(game.id, notes => this.applyNotes(game.id, notes))
      }
      return true
    } catch (error) { if (this.visible && epoch === this.epoch) { this.setData({ loading: false, saveStatus: '加载失败，请重试' }); if (showFailure) showError(error) }; return false }
    finally { if (epoch === this.epoch) { this.fetching = false; if (this.pendingRefresh) { this.pendingRefresh = false; const pending = this.pendingSnapshot; this.pendingSnapshot = undefined; this.load(false, pending) } } }
  },
  applyNotes(gameId: string, notes: NoteView[]) {
    if (!this.visible || gameId !== this.gameId || !this.data.room) return
    const merged: NoteView[] = []
    for (const note of notes) {
      const key = String(note.targetSeat), revision = note.revision || 0
      if (this.dirty[key] || revision < (this.cloudRevisions[key] || 0)) continue
      this.cloudRevisions[key] = revision; merged.push(note)
    }
    const rows = noteRows(this.data.room, merged)
    this.setData({ rows: this.data.rows.map(row => merged.some(note => note.targetSeat === row.seat) ? rows.find(next => next.seat === row.seat) || row : row) })
    if (this.data.roleSheetOpen) this.refreshRoleOptions()
    const summary = merged.find(note => note.kind === 'summary')
    if (summary) this.setData({ freeText: summary.freeText || '', voteText: summary.voteText || '' })
  },
  announce() {
    const room = this.data.room
    if (!this.visible || !room) return
    const current = announcementFor(room)
    syncBroadcast(room, this.myId, current.name, current.key)
  },
  refreshRoleOptions() {
    const row = this.data.rows.find(row => row.seat === this.data.selectedSeat)
    const guesses = row ? guessesFor(row) : []
    this.setData({ roleOptions: roleGuesses.map(role => ({ role, tone: guessTone(role), selected: role === '未知' ? !guesses.length : guesses.includes(role) })), remaining: this.data.room ? remainingGuesses(this.data.room, this.data.rows) : this.data.remaining })
  },
  openRole(e: WechatMiniprogram.TouchEvent) { this.setData({ selectedSeat: Number(e.currentTarget.dataset.seat), roleSheetOpen: true }); this.refreshRoleOptions() },
  closeRole() { this.setData({ roleSheetOpen: false }) }, noop() {},
  chooseRole(e: WechatMiniprogram.TouchEvent) {
    const role = String(e.currentTarget.dataset.role)
    const row = this.data.rows.find(row => row.seat === this.data.selectedSeat)
    if (!row || !roleGuesses.includes(role)) return
    const current = guessesFor(row)
    const guesses = role === '未知' ? [] : current.includes(role) ? current.filter(item => item !== role) : [...current, role]
    const tone = guessesTone(guesses)
    this.editRow(this.data.selectedSeat, { roleGuesses: guesses, roleGuess: guesses.join(' / ') || '未知', tone, tendency: tone === 'wolf' ? '偏狼' : tone === 'god' || tone === 'civilian' ? '偏好' : '未知' })
    this.refreshRoleOptions()
  },
  speechInput(e: WechatMiniprogram.Input) { this.editRow(Number(e.currentTarget.dataset.seat), { text: e.detail.value }) },
  editRow(seat: number, change: Partial<NoteRow>) {
    if (!this.gameId) return
    const index = this.data.rows.findIndex(row => row.seat === seat)
    if (index < 0) return
    const patch: { [key: string]: unknown } = {}
    for (const key of Object.keys(change)) patch[`rows[${index}].${key}`] = change[key as keyof NoteRow]
    this.setData(patch); this.markDirty(seat)
  },
  freeInput(e: WechatMiniprogram.TextareaInput) { this.setData({ freeText: e.detail.value }); this.markDirty(0) },
  voteInput(e: WechatMiniprogram.TextareaInput) { this.setData({ voteText: e.detail.value }); this.markDirty(0) },
  noteFor(seat: number): NoteView {
    if (seat === 0) return { revision: this.cloudRevisions['0'] || 0, kind: 'summary', targetSeat: 0, tendency: '未知', tags: [], text: '', freeText: this.data.freeText, voteText: this.data.voteText }
    const row = this.data.rows.find(item => item.seat === seat)
    return row ? { ...rowNote(row), revision: this.cloudRevisions[String(seat)] || 0 } : { targetSeat: seat, tendency: '未知', tags: [], text: '' }
  },
  writeDraft() {
    clearTimeout(this.draftTimer)
    if (!this.draftKey) return
    const notes = Object.keys(this.dirty).map(key => this.noteFor(Number(key)))
    try { if (notes.length) wx.setStorageSync(this.draftKey, { gameId: this.gameId, notes }); else wx.removeStorageSync(this.draftKey) } catch (_) { /* Cloud saving still works when local storage is full. */ }
  },
  markDirty(seat: number) {
    if (!this.gameId) return
    this.dirty[String(seat)] = ++this.revision;
    clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => this.writeDraft(), 150) as unknown as number; this.setData({ saveStatus: '正在保存…' })
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveAll(), 650) as unknown as number
  },
  saveAll() {
    clearTimeout(this.saveTimer)
    const gameId = this.gameId, draftKey = this.draftKey
    if (!gameId) return Promise.resolve()
    this.queue = this.queue.then(async () => {
      if (gameId !== this.gameId || draftKey !== this.draftKey) return
      const keys = Object.keys(this.dirty)
      if (!keys.length) return
      const revisions = keys.map(key => this.dirty[key])
      const notes = keys.map(key => this.noteFor(Number(key)))
      try {
        const saved = await api.saveNotes(notes, gameId)
        if (gameId !== this.gameId || draftKey !== this.draftKey) return
        saved.forEach(note => { this.cloudRevisions[String(note.targetSeat)] = note.revision || 0 })
        keys.forEach((key, index) => { if (this.dirty[key] === revisions[index]) delete this.dirty[key] })
      } catch (error) {
        if (gameId !== this.gameId || draftKey !== this.draftKey) return
        if (error instanceof ApiError && error.code === 'NOTE_CONFLICT') this.noteConflict = true
      }
      if (gameId !== this.gameId) return
      this.writeDraft()
      if (this.visible) this.setData({ saveStatus: Object.keys(this.dirty).length ? this.noteConflict ? '其他设备已修改 · 草稿已保留，点击处理' : '未同步 · 草稿已保留，点击重试' : '已保存 · 仅自己可见' })
    })
    return this.queue
  },
  openGraph() { if (!this.gameId) return; this.openingGraph = true; wx.navigateTo({ url: '/pages/relations/relations', fail: () => { this.openingGraph = false } }) },
  back() { this.returningToGame = true; this.saveAll(); wx.navigateBack({ fail: () => { this.returningToGame = false } }) },
  retry() {
    if (!this.loadedGameId) { this.load(true); return }
    if (!this.noteConflict) { this.saveAll(); return }
    wx.showModal({ title: '笔记修改冲突', content: '草稿已保留。确认后会读取云端版本并尝试保存本机草稿；取消可继续编辑。', confirmText: '保存草稿', success: async result => {
      if (!result.confirm) return
      const gameId = this.gameId, draftKey = this.draftKey
      try {
        const latest = await api.listNotes(gameId)
        if (!this.visible || gameId !== this.gameId || draftKey !== this.draftKey) return
        latest.forEach(note => { this.cloudRevisions[String(note.targetSeat)] = note.revision || 0 })
        this.noteConflict = false; this.writeDraft(); await this.saveAll()
      } catch (error) { showError(error) }
    } })
  },
})
