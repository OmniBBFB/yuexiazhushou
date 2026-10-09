import { api, showError } from '../../api/client'
import { rulesForRoom, RoomRulesView } from '../../domain/room-rules'
import { voteSections } from '../../domain/vote-sections'
import { MyActionView, RoomView, VoteHistoryView } from '../../domain/types'
import { setChangedData } from '../../services/page-data'
import { watchRoom, serverOffset } from '../../services/room-controller'
import { Announcement } from '../../services/announcer'
import { announcementFor } from '../../services/announcements'
import { startBroadcast, stopBroadcast, syncBroadcast } from '../../services/broadcast'
Page({
  data: { stageHistoryOpen: false, currentVote: null as VoteHistoryView | null, previousVotes: [] as VoteHistoryView[], voteHistoryNewest: [] as VoteHistoryView[], rulesOpen: false, roomRules: null as RoomRulesView | null, identityOpen: false, voteSheetOpen: false, room: null as RoomView | null, myId: '', mySeat: 0, isOwner: false, phase: '', phaseLabel: '', announcementText: '', playingHere: false, actionReady: true, action: null as MyActionView | null, selectedSeat: 0, selectedDaySeat: 0, speechDirection: 'ASC' as 'ASC' | 'DESC', countdown: 0, useSave: false, usePoison: false, poisonSeat: 0, dawnText: '', dawnConfirmed: false, confirmationRequired: true },
  poller: 0 as number,
  clocker: 0 as number,
  serverClockOffset: 0,
  loadEpoch: 0,
  loadingRequest: false,
  visible: false,
  leaving: false,
  openingNotes: false, openingBroadcast: false,
  stopSync: (() => {}) as () => void,
  syncConnected: false,
  pendingRefresh: false,
  lastRefreshAt: 0,
  deadlineTimer: 0 as number,
  heartbeatTimer: 0 as number,
  async onShow() { this.visible = true; this.leaving = false; this.openingNotes = false; this.openingBroadcast = false; this.loadEpoch += 1; this.loadingRequest = false; this.pendingRefresh = false; startBroadcast(); clearInterval(this.poller); clearInterval(this.clocker); await this.load(true); if (!this.visible || this.leaving) return; this.stopSync = watchRoom(() => this.load(false), connected => { this.syncConnected = connected }, () => this.data.room, room => this.applyRoom(room));  this.heartbeatTimer = setInterval(() => { const room = this.data.room; if (room) this.announce(room) }, 3000) as unknown as number; this.clocker = setInterval(() => this.tick(), 1000) as unknown as number },
  onHide() { if (!this.visible) return; this.visible = false; this.setData({ identityOpen: false, voteSheetOpen: false, rulesOpen: false }); this.stopSync(); this.syncConnected = false; clearTimeout(this.deadlineTimer); clearInterval(this.heartbeatTimer); this.loadEpoch += 1; clearInterval(this.poller); clearInterval(this.clocker); if (!this.openingNotes && !this.openingBroadcast) stopBroadcast() },
  onUnload() { this.onHide() },
  tick() { const room = this.data.room; const deadline = room && room.game && room.game.dayView ? room.game.dayView.speechDeadline : 0; const countdown = deadline ? Math.max(0, Math.ceil((deadline - Date.now() - this.serverClockOffset) / 1000)) : 0; if (countdown !== this.data.countdown) this.setData({ countdown }) },
  async load(showFailure: boolean): Promise<boolean | void> {
    if (!this.visible || this.leaving) return
    if (this.loadingRequest) { this.pendingRefresh = true; return }
    const epoch = this.loadEpoch
    this.loadingRequest = true
    try {
      const sentAt = Date.now()
      const session = this.data.myId ? { profile: { id: this.data.myId }, room: await api.getRoom() } : await api.session();
      if (!this.visible || epoch !== this.loadEpoch) return
      this.lastRefreshAt = Date.now()
      if (session.room) this.serverClockOffset = serverOffset(session.room, sentAt, this.lastRefreshAt)
      if (this.data.myId !== session.profile.id) this.setData({ myId: session.profile.id }); this.applyRoom(session.room)
      return true
    } catch (error) { if (showFailure && this.visible && epoch === this.loadEpoch) showError(error); return false }
    finally { if (epoch === this.loadEpoch) { this.loadingRequest = false; if (this.pendingRefresh) { this.pendingRefresh = false; this.load(false) } } }
  },
  navigateAway(url: string, relaunch = false) {
    if (!this.visible || this.leaving) return
    this.leaving = true
    const epoch = this.loadEpoch
    const options = { url, fail: (error: WechatMiniprogram.GeneralCallbackResult) => {
      if (!this.visible || epoch !== this.loadEpoch) return
      this.leaving = false
      showError(error)
    } }
    if (relaunch) wx.reLaunch(options)
    else wx.redirectTo(options)
  },
  applyRoom(room: RoomView | null) {
    if (!this.visible || this.leaving) return
    const current = this.data.room
    if (room && current && room.id === current.id && (room.version < current.version || room.broadcast.version < current.broadcast.version)) return
     if (!room) { this.navigateAway('/pages/index/index', true); return } if (!room.game) { clearInterval(this.poller); this.navigateAway('/pages/room/room'); return } if (room.game.phase === 'ROLE_REVEAL') { clearInterval(this.poller); this.navigateAway('/pages/role/role'); return } const game = room.game; const stageChanged = !current || !current.game || current.game.day !== game.day || current.game.phase !== game.phase || current.game.nightStage !== game.nightStage || (current.game.dayView && current.game.dayView.stage) !== (game.dayView && game.dayView.stage) || (current.game.dayView && current.game.dayView.shooterSeat) !== (game.dayView && game.dayView.shooterSeat) || (current.game.dayView && current.game.dayView.voteRound) !== (game.dayView && game.dayView.voteRound); if (stageChanged) { if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 }); this.setData({ stageHistoryOpen: false, selectedSeat: 0, selectedDaySeat: 0, useSave: false, usePoison: false, poisonSeat: 0 }) }; const labels: { [key: string]: string } = { NIGHT: '夜间行动', DAWN: '黎明确认', DAY: '白天流程', FINISHED: '对局结束' }; const dayLabels: { [key: string]: string } = { SHERIFF_SIGNUP: '竞选警长', SHERIFF_SPEECH: '竞选发言', SHERIFF_PK_SPEECH: '竞选 PK', EXILE_PK_SPEECH: '放逐 PK', SHERIFF_VOTE: '选举警长', NIGHT_RESULT: '首夜结果', SPEECH_ORDER: '发言顺序', SPEECH: '发言阶段', EXILE_VOTE: '放逐投票', DEATH_SKILL: '死亡技能', COMPLETE: '白天结束' }; const phaseLabel = game.phase === 'DAY' && game.dayView ? dayLabels[game.dayView.stage] || labels.DAY : labels[game.phase] || game.phase; const dawnText = game.resultPending ? '首夜结果将在警长竞选结束后公布' : game.publicResult.length ? `昨夜，${game.publicResult.join('、')} 号玩家离场` : '昨夜是一个平安夜'; const countdown = game.dayView && game.dayView.speechDeadline ? Math.max(0, Math.ceil((game.dayView.speechDeadline - Date.now() - this.serverClockOffset) / 1000)) : 0; setChangedData(this, { ...voteSections(game), room, myId: this.data.myId, mySeat: (room.members.find(member => member.userId === this.data.myId) || { seat: 0 }).seat, isOwner: room.ownerId === this.data.myId, phase: game.phase, phaseLabel, actionReady: !game.stageReadyAt || game.stageReadyAt <= (game.serverTime || Date.now()), action: game.myAction || null, dawnText, dawnConfirmed: game.myConfirmed, confirmationRequired: game.confirmationRequired !== false, countdown }); this.announce(room)
  },
  currentAnnouncement(room: RoomView): { name: Announcement | ''; text: string } { return announcementFor(room) },
  async announce(room: RoomView) {
    if (!room.game) return
    const announcement = this.currentAnnouncement(room)
    if (this.data.announcementText !== announcement.text) this.setData({ announcementText: announcement.text })
    const key = room.game.id + ':' + room.game.day + ':' + room.game.phase + ':' + room.game.nightStage + ':' + room.game.nightCue
    const playingHere = await syncBroadcast(room, this.data.myId, announcement.name, key)
    if (this.visible && this.data.room && this.data.room.id === room.id && this.data.room.version === room.version && this.data.room.broadcast.version === room.broadcast.version && this.data.playingHere !== playingHere) this.setData({ playingHere })
  },
  toggleStageHistory() { this.setData({ stageHistoryOpen: !this.data.stageHistoryOpen }) },
  selectTarget(e: WechatMiniprogram.TouchEvent) { this.setData({ selectedSeat: Number(e.currentTarget.dataset.seat) }) },
  async suggestWolfTarget() {
    const room = this.data.room, action = this.data.action
    if (!room || !action || action.type !== 'WEREWOLF' || !this.data.actionReady) return
    if (!this.data.selectedSeat) { wx.showToast({ title: '请先选择建议目标', icon: 'none' }); return }
    try { await api.suggestWolfTarget(this.data.selectedSeat, room.version) }
    catch (error) { showError(error); await this.load(false) }
  },
  selectPoison(e: WechatMiniprogram.TouchEvent) { if (!this.data.actionReady || !this.data.usePoison || !this.data.action || !this.data.action.canPoison) return; const seat = Number(e.currentTarget.dataset.seat); this.setData({ poisonSeat: this.data.poisonSeat === seat ? 0 : seat }) },
  toggleSave(e: WechatMiniprogram.SwitchChange) { const action = this.data.action; if (!this.data.actionReady || !action || !action.canSave || !action.attackedSeat) return; this.setData({ useSave: e.detail.value, ...(e.detail.value ? { usePoison: false, poisonSeat: 0 } : {}) }) },
  togglePoison(e: WechatMiniprogram.SwitchChange) { const action = this.data.action; if (!this.data.actionReady || !action || !action.canPoison) return; this.setData({ usePoison: e.detail.value, poisonSeat: 0, ...(e.detail.value ? { useSave: false } : {}) }) },
  async submitAction() { const room = this.data.room; const action = this.data.action; if (!room || !action) return; let payload: { [key: string]: unknown } = { version: room.version }; if ((action.type === 'SEER' || action.type === 'GRAVEKEEPER') && action.result) payload.confirmResult = true; else if (action.type === 'WITCH') { if (this.data.useSave && this.data.usePoison) { wx.showToast({ title: '同一晚只能使用一种药剂', icon: 'none' }); return } if (this.data.usePoison && !this.data.poisonSeat) { wx.showToast({ title: '请选择毒药目标', icon: 'none' }); return } payload.useSave = this.data.useSave; payload.poisonSeat = this.data.usePoison ? this.data.poisonSeat : 0 } else { if (!this.data.selectedSeat) { wx.showToast({ title: '请选择目标', icon: 'none' }); return } payload.targetSeat = this.data.selectedSeat } try { await api.submitNightAction(payload); this.setData({ selectedSeat: 0, poisonSeat: 0, useSave: false, usePoison: false }); } catch (error) { showError(error); await this.load(false) } },
  async confirmDawn() { const room = this.data.room; if (!room) return; try { await api.confirmDawn(room.version); } catch (error) { showError(error); await this.load(false) } },
  async aliveChange(e: WechatMiniprogram.SwitchChange) { const room = this.data.room; if (!room) return; try { await api.updateAlive(Number(e.currentTarget.dataset.seat), e.detail.value, room.version); } catch (error) { showError(error); await this.load(false) } },
  selectDayTarget(e: WechatMiniprogram.TouchEvent) { this.setData({ selectedDaySeat: Number(e.currentTarget.dataset.seat) }) },
  extendingSpeech: false,
  async withdrawSheriff() { const room = this.data.room; if (!room) return; try { await api.withdrawSheriff(room.version) } catch (error) { showError(error); await this.load(false) } },
  async extendSpeech() {
    const room = this.data.room
    if (!room || this.extendingSpeech) return
    this.extendingSpeech = true
    try { await api.extendSpeech(room.version) }
    catch (error) { showError(error); await this.load(false) }
    finally { this.extendingSpeech = false }
  },
  async sheriffSignup(e: WechatMiniprogram.TouchEvent) { const room = this.data.room; if (!room) return; try { await api.sheriffSignup(e.currentTarget.dataset.join === true || e.currentTarget.dataset.join === 'true', room.version); } catch (error) { showError(error); await this.load(false) } },
  async sheriffVote() { const room = this.data.room; if (!room || !this.data.selectedDaySeat) { wx.showToast({ title: '请选择候选人', icon: 'none' }); return } try { await api.sheriffVote(this.data.selectedDaySeat, room.version); this.setData({ selectedDaySeat: 0 }); } catch (error) { showError(error); await this.load(false) } },
  async confirmFirstNightResult() { const room = this.data.room; if (!room) return; try { await api.confirmFirstNightResult(room.version); } catch (error) { showError(error); await this.load(false) } },
  setDirection(e: WechatMiniprogram.TouchEvent) { this.setData({ speechDirection: e.currentTarget.dataset.direction }) },
  async setSpeechOrder() { const room = this.data.room; if (!room) return; try { await api.setSpeechOrder(this.data.speechDirection, room.version); } catch (error) { showError(error); await this.load(false) } },
  async finishSpeech() { const room = this.data.room; if (!room) return; try { await api.finishSpeech(room.version); } catch (error) { showError(error); await this.load(false) } },
  async exileVote() { const room = this.data.room; if (!room) return; try { await api.exileVote(this.data.selectedDaySeat, room.version); this.setData({ selectedDaySeat: 0 }); } catch (error) { showError(error); await this.load(false) } },
  wolfExplode() { const room = this.data.room; if (!room) return; if (room.game && room.game.myRole && room.game.myRole.role === '白狼王' && !this.data.selectedDaySeat) { wx.showToast({ title: '请选择自爆带走的目标', icon: 'none' }); return } wx.showModal({ title: '确认自爆？', content: room.game && room.game.myRole && room.game.myRole.role === '白狼王' ? `你将与 ${this.data.selectedDaySeat} 号一同出局，白天流程终止。` : '你将立即出局，白天流程终止；首夜结果尚未公布时，先公布首夜情况，再进入下一阶段。', confirmText: '确认自爆', confirmColor: '#c96f6f', success: async result => { if (!result.confirm) return; try { await api.wolfExplode(room.version, room.game && room.game.myRole && room.game.myRole.role === '白狼王' ? this.data.selectedDaySeat : 0); } catch (error) { showError(error); await this.load(false) } } }) },
  async shoot(e: WechatMiniprogram.TouchEvent) { const room = this.data.room; if (!room) return; const skip = e.currentTarget.dataset.skip === true || e.currentTarget.dataset.skip === 'true'; if (!skip && !this.data.selectedDaySeat) { wx.showToast({ title: '请选择开枪目标', icon: 'none' }); return } wx.showModal({ title: skip ? '放弃开枪？' : '确认开枪？', content: skip ? '放弃后不能再次开枪。' : `将带走 ${this.data.selectedDaySeat} 号玩家。`, success: async result => { if (!result.confirm) return; try { await api.shoot(skip ? 0 : this.data.selectedDaySeat, room.version); this.setData({ selectedDaySeat: 0 }) } catch (error) { showError(error); await this.load(false) } } }) },
  knightDuel() { const room = this.data.room; if (!room || !this.data.selectedDaySeat) { wx.showToast({ title: '请选择决斗目标', icon: 'none' }); return } wx.showModal({ title: '确认决斗？', content: `与 ${this.data.selectedDaySeat} 号决斗，若对方是好人，你将出局。技能整局只能使用一次。`, success: async result => { if (!result.confirm || !room) return; try { await api.knightDuel(this.data.selectedDaySeat, room.version); this.setData({ selectedDaySeat: 0 }) } catch (error) { showError(error); await this.load(false) } } }) },
  async nextNight() { const room = this.data.room; if (!room) return; try { await api.nextNight(room.version); } catch (error) { showError(error); await this.load(false) } },
  async finishGame() { const room = this.data.room; if (!room) return; wx.showModal({ title: '结束本局？', content: '结束后将向所有玩家公开身份。', success: async result => { if (!result.confirm) return; try { await api.finishGame(room.version); } catch (error) { showError(error) } } }) },
  async backRoom() { const room = this.data.room; if (!room) return; try { await api.nextGame(room.version) } catch (error) { showError(error) } },
  openIdentity() { if (this.data.room && this.data.room.game && this.data.room.game.myRole) this.setData({ identityOpen: true, voteSheetOpen: false, rulesOpen: false }) },
  closeIdentity() { this.setData({ identityOpen: false }) },
  openVotes() { this.setData({ voteSheetOpen: true, identityOpen: false, rulesOpen: false }) },
  openRules() { const room = this.data.room; if (!room) return; this.setData({ rulesOpen: true, roomRules: rulesForRoom(room.config), identityOpen: false, voteSheetOpen: false }) },
  closeRules() { this.setData({ rulesOpen: false }) },
  closeVotes() { this.setData({ voteSheetOpen: false }) },
  keepSheet() {},
  openNotes() { this.openingNotes = true; wx.navigateTo({ url: '/pages/notes/notes', fail: () => { this.openingNotes = false } }) },
  openBroadcast() { this.openingBroadcast = true; wx.navigateTo({ url: '/pages/broadcast/broadcast', fail: () => { this.openingBroadcast = false } }) },
})
