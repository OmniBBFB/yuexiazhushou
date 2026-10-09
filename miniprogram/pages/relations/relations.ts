import { api, ApiError, showError } from '../../api/client'
import { RelationEdge, RoomView, NoteView } from '../../domain/types'
import { setRelation, validRelations, seatPositions } from '../../domain/relations'
import { watchRoom } from '../../services/room-controller'
import { watchNotes } from '../../services/notes-sync'
import { startBroadcast, stopBroadcast, syncBroadcast } from '../../services/broadcast'
import { announcementFor } from '../../services/announcements'

type DrawingContext = Pick<WechatMiniprogram.CanvasContext, 'scale' | 'clearRect' | 'beginPath' | 'moveTo' | 'quadraticCurveTo' | 'stroke' | 'lineTo' | 'closePath' | 'fill' | 'fillText' | 'globalAlpha' | 'strokeStyle' | 'fillStyle' | 'lineWidth' | 'font'> & { textAlign: string }
interface BoardCanvas { width: number; height: number; getContext(type: string): DrawingContext }
interface Draft { gameId: string; revision: number; edges: RelationEdge[] }
Page({
  data: { loading: true, status: '正在加载', mode: '' as '' | 'ATTACK' | 'SUPPORT', focus: 0, source: 0,
    nodes: [] as { seat: number; x: number; y: number; dead: boolean }[], edges: [] as RelationEdge[],
    related: [] as (RelationEdge & { label: string; key: string })[], canUndo: false, canRedo: false },
  visible: false, returning: false, epoch: 0, gameId: '', myId: '', draftKey: '', revision: 0, generation: 0, dirty: false, conflict: false,
  room: null as RoomView | null, history: [] as RelationEdge[][], future: [] as RelationEdge[][],
  timer: 0 as number, heartbeat: 0 as number, queue: Promise.resolve(), stopRoom: (() => {}) as () => void, stopNotes: (() => {}) as () => void,
  async onShow() {
    this.visible = true; this.returning = false; const epoch = ++this.epoch; startBroadcast()
    try {
      await this.queue
      if (!this.visible || epoch !== this.epoch) return
      const session = await api.session()
      if (!this.visible || epoch !== this.epoch) return
      if (!session.room || !session.room.game) { this.back(); return }
      const room = session.room, gameId = room.game!.id
      const notes = await api.listNotes(gameId)
      if (!this.visible || epoch !== this.epoch) return
      this.myId = session.profile.id; this.gameId = gameId; this.room = room; this.draftKey = `night-relations:${this.myId}:${gameId}`
      const saved = notes.find(note => note.kind === 'relations')
      this.revision = saved ? saved.revision || 0 : 0; this.dirty = false; this.conflict = false
      this.history = []; this.future = []
      let edges = saved && saved.edges || []
      const draft = wx.getStorageSync(this.draftKey) as Draft | undefined
      if (draft && draft.gameId === gameId && Number.isInteger(draft.revision) && validRelations(draft.edges, room.members.map(member => member.seat))) {
        edges = draft.edges; this.revision = draft.revision; this.dirty = true; this.generation++
      }
      this.setData({ loading: false, edges, focus: 0, source: 0, mode: '', status: this.dirty ? '草稿待同步' : '已保存 · 仅自己可见' })
      this.updateRoom(room); this.updateView()
      this.stopNotes = watchNotes(gameId, notes => this.receive(notes))
      this.stopRoom = watchRoom(() => this.refresh(), () => {}, () => this.room, room => {
        if (room && room.game && room.game.id === this.gameId) this.updateRoom(room)
        else if (this.visible) this.back()
      })
      this.heartbeat = setInterval(() => this.announce(), 3000) as unknown as number
      if (this.dirty) this.saveAll()
    } catch (error) { if (this.visible && epoch === this.epoch) { this.setData({ status: '加载失败，点击重试' }); showError(error) } }
  },
  onHide() {
    if (!this.visible) return
    this.visible = false; this.epoch++; this.stopRoom(); this.stopNotes(); clearInterval(this.heartbeat); clearTimeout(this.timer)
    this.writeDraft(); this.saveAll(); if (!this.returning) stopBroadcast()
  },
  onUnload() { this.onHide() },
  async refresh() {
    const epoch = this.epoch
    try {
      const room = await api.getRoom()
      if (!this.visible || epoch !== this.epoch) return
      if (!room || !room.game || room.game.id !== this.gameId) { this.back(); return }
      this.updateRoom(room)
      if (!this.dirty) { const notes = await api.listNotes(this.gameId); if (this.visible && epoch === this.epoch) this.receive(notes) }
    } catch (_) { /* Keep the local board available during transport failures. */ }
  },
  updateRoom(room: RoomView) {
    this.room = room
    const members = room.members.filter(member => member.seat > 0).sort((a, b) => a.seat - b.seat)
    this.setData({ nodes: seatPositions(members.map(member => member.seat)).map(node => ({ ...node, dead: false })) })
    // Use only the public alive status supplied in the room view.
    this.setData({ nodes: this.data.nodes.map(node => ({ ...node, dead: this.isDead(node.seat) })) })
    this.announce(); this.draw()
  },
  isDead(seat: number) {
    const player = this.room && this.room.members.find(item => item.seat === seat)
    return !!player && !player.alive
  },
  announce() {
    if (!this.visible || !this.room) return
    const current = announcementFor(this.room); syncBroadcast(this.room, this.myId, current.name, current.key)
  },
  receive(notes: NoteView[]) {
    if (!this.visible || this.dirty) return
    const note = notes.find(item => item.kind === 'relations')
    if (!note || (note.revision || 0) <= this.revision) return
    this.revision = note.revision || 0; this.history = []; this.future = []
    this.setData({ edges: note.edges || [], status: '已同步 · 仅自己可见' }); this.updateView()
  },
  chooseMode(e: WechatMiniprogram.TouchEvent) {
    const mode = String(e.currentTarget.dataset.mode)
    if (mode !== 'ATTACK' && mode !== 'SUPPORT' && mode !== '') return
    this.setData({ mode: mode === this.data.mode ? '' : mode, source: 0 }); this.draw()
  },
  tapSeat(e: WechatMiniprogram.TouchEvent) {
    if (this.data.loading) return
    const seat = Number(e.currentTarget.dataset.seat)
    if (!this.data.mode) { this.setData({ focus: this.data.focus === seat ? 0 : seat }); this.updateView(); return }
    if (!this.data.source) { this.setData({ source: seat, focus: seat }); this.updateView(); return }
    if (this.data.source === seat) { this.setData({ source: 0 }); this.draw(); return }
    this.commit(setRelation(this.data.edges, { source: this.data.source, target: seat, type: this.data.mode }))
    this.setData({ source: 0 })
  },
  commit(edges: RelationEdge[]) {
    if (edges === this.data.edges || this.data.loading) return
    this.history.push(this.data.edges.map(edge => ({ ...edge }))); if (this.history.length > 100) this.history.shift()
    this.future = []; this.setData({ edges }); this.changed()
  },
  undo() { const edges = this.history.pop(); if (!edges) return; this.future.push(this.data.edges); this.setData({ edges, source: 0 }); this.changed() },
  redo() { const edges = this.future.pop(); if (!edges) return; this.history.push(this.data.edges); this.setData({ edges, source: 0 }); this.changed() },
  changed() {
    this.dirty = true; this.generation++; this.setData({ status: '正在保存…' }); this.writeDraft(); this.updateView()
    clearTimeout(this.timer); this.timer = setTimeout(() => this.saveAll(), 650) as unknown as number
  },
  updateView() {
    const focus = this.data.focus
    this.setData({ canUndo: !!this.history.length, canRedo: !!this.future.length,
      related: this.data.edges.filter(edge => !focus || edge.source === focus || edge.target === focus).map(edge => ({ ...edge, label: `${edge.source} → ${edge.target} · ${edge.type === 'ATTACK' ? '踩' : '站'}`, key: `${edge.source}:${edge.target}` })) })
    this.draw()
  },
  editEdge(e: WechatMiniprogram.TouchEvent) {
    const source = Number(e.currentTarget.dataset.source), target = Number(e.currentTarget.dataset.target)
    const edge = this.data.edges.find(item => item.source === source && item.target === target)
    if (!edge) return
    const epoch = this.epoch
    wx.showActionSheet({ itemList: [edge.type === 'ATTACK' ? '改为站' : '改为踩', '删除连线'], success: result => {
      if (!this.visible || epoch !== this.epoch) return
      this.commit(result.tapIndex === 1 ? this.data.edges.filter(item => item.source !== source || item.target !== target) : setRelation(this.data.edges, { source, target, type: edge.type === 'ATTACK' ? 'SUPPORT' : 'ATTACK' }))
    } })
  },
  clear() { const epoch = this.epoch; wx.showModal({ title: '清空关系图', content: '清空当前全部连线，可通过撤销恢复。', success: result => { if (result.confirm && this.visible && epoch === this.epoch && this.data.edges.length) this.commit([]) } }) },
  writeDraft() {
    if (!this.draftKey) return
    try { if (this.dirty) wx.setStorageSync(this.draftKey, { gameId: this.gameId, revision: this.revision, edges: this.data.edges }); else wx.removeStorageSync(this.draftKey) } catch (_) { /* Saving to the backend remains available. */ }
  },
  saveAll() {
    clearTimeout(this.timer)
    const gameId = this.gameId, draftKey = this.draftKey
    this.queue = this.queue.then(async () => {
      if (!gameId || gameId !== this.gameId || draftKey !== this.draftKey || !this.dirty || this.conflict) return
      const generation = this.generation
      try {
        const saved = await api.saveNote({ kind: 'relations', targetSeat: -1, edges: this.data.edges, revision: this.revision, tendency: '未知', tags: [], text: '' }, gameId)
        if (gameId !== this.gameId || draftKey !== this.draftKey) return
        this.revision = saved.revision || 0; if (generation === this.generation) this.dirty = false
      } catch (error) { if (gameId !== this.gameId || draftKey !== this.draftKey) return; this.conflict = error instanceof ApiError && error.code === 'NOTE_CONFLICT' }
      this.writeDraft()
      if (this.visible) this.setData({ status: this.dirty ? this.conflict ? '其他设备已修改 · 点击处理' : '草稿已保留 · 点击重试' : '已保存 · 仅自己可见' })
    })
    return this.queue
  },
  retry() {
    if (this.data.loading) { this.onHide(); this.onShow(); return }
    if (!this.conflict) { this.saveAll(); return }
    const gameId = this.gameId, epoch = this.epoch
    wx.showModal({ title: '关系图修改冲突', content: '保留本机草稿并覆盖云端当前关系图？', confirmText: '保存草稿', success: async result => {
      if (!result.confirm) return
      try {
        const notes = await api.listNotes(gameId)
        if (!this.visible || epoch !== this.epoch || gameId !== this.gameId) return
        const note = notes.find(item => item.kind === 'relations'); this.revision = note ? note.revision || 0 : 0; this.conflict = false; this.writeDraft(); this.saveAll()
      } catch (error) { showError(error) }
    } })
  },
  back() { this.returning = true; wx.navigateBack({ fail: () => { this.returning = false } }) },
  draw() {
    if (!this.visible || this.data.loading) return
    const epoch = this.epoch
    wx.createSelectorQuery().in(this).select('#relations').fields({ node: true, size: true }, rect => {
      if (!rect || Array.isArray(rect) || !this.visible || epoch !== this.epoch) return
      const canvas = rect.node as BoardCanvas
      if (!canvas) return
      const width = Number(rect.width), height = Number(rect.height)
      canvas.width = width * 2; canvas.height = height * 2
      const ctx = canvas.getContext('2d'); ctx.scale(2, 2)
      ctx.clearRect(0, 0, width, height)
      for (const edge of this.data.edges) {
        const a = this.data.nodes.find(node => node.seat === edge.source), b = this.data.nodes.find(node => node.seat === edge.target)
        if (!a || !b) continue
        const ax = a.x * width / 100, ay = a.y * height / 100, bx = b.x * width / 100, by = b.y * height / 100
        const dx = bx - ax, dy = by - ay, distance = Math.sqrt(dx * dx + dy * dy)
        if (!distance) continue
        const cx = (ax + bx) / 2 - dy / distance * 20, cy = (ay + by) / 2 + dx / distance * 20
        const startLength = Math.sqrt((cx - ax) ** 2 + (cy - ay) ** 2), endLength = Math.sqrt((bx - cx) ** 2 + (by - cy) ** 2)
        const sx = ax + (cx - ax) / startLength * 23, sy = ay + (cy - ay) / startLength * 23
        const ex = bx - (bx - cx) / endLength * 25, ey = by - (by - cy) / endLength * 25
        const color = edge.type === 'ATTACK' ? '#c44c60' : '#278c62'
        ctx.globalAlpha = this.data.focus && edge.source !== this.data.focus && edge.target !== this.data.focus ? .13 : 1
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke()
        const angle = Math.atan2(ey - cy, ex - cx)
        ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 7 * Math.cos(angle - .5), ey - 7 * Math.sin(angle - .5)); ctx.lineTo(ex - 7 * Math.cos(angle + .5), ey - 7 * Math.sin(angle + .5)); ctx.closePath(); ctx.fill()
        ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(edge.type === 'ATTACK' ? '踩' : '站', (sx + 2 * cx + ex) / 4, (sy + 2 * cy + ey) / 4 - 3)
      }
    }).exec()
  },
})
