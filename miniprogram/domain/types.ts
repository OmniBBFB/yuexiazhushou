export type Gender = '保密' | '男' | '女'
export type Role = '狼人' | '预言家' | '女巫' | '猎人' | '守卫' | '村民' | '野孩子' | '白痴' | '守墓人' | '骑士' | '白狼王' | '狼王'
export type GodRole = '预言家' | '女巫' | '猎人' | '守卫' | '白痴' | '守墓人' | '骑士'
export type WolfRole = '白狼王' | '狼王'
export type Phase = 'WAITING' | 'ROLE_REVEAL' | 'NIGHT' | 'DAWN' | 'DAY' | 'FINISHED'
export type NightStage = 'WILD_CHILD' | 'WEREWOLF' | 'SEER' | 'WITCH' | 'GUARD' | 'GRAVEKEEPER' | 'RESOLVE'
export type DayStage = 'SHERIFF_SIGNUP' | 'SHERIFF_SPEECH' | 'SHERIFF_PK_SPEECH' | 'SHERIFF_VOTE' | 'NIGHT_RESULT' | 'SPEECH_ORDER' | 'SPEECH' | 'EXILE_VOTE' | 'EXILE_PK_SPEECH' | 'DEATH_SKILL' | 'COMPLETE'
export interface ProfileView { id: string; nickname: string; gender: Gender; avatar: string }
export interface RoomConfig { total: number; wolves: number; gods: number; villagers: number; godRoles?: GodRole[]; wolfRoles?: WolfRole[]; wildChild?: boolean; winMode: '屠边' | '屠城'; interval: number; password?: string }
export interface MemberView { userId: string; nickname: string; seat: number; ready: boolean; alive: boolean; online: boolean; roleConfirmed: boolean; isOwner: boolean; isBot: boolean; revealedRole?: Role; finalRole?: Role; finalCamp?: 'VILLAGE' | 'WOLF' }
export interface MyRoleView { role: Role; description: string; confirmed: boolean; transformed?: boolean; modelSeat?: number; graveResult?: { day: number; seat: number; camp: string } }
export interface ActionTarget { seat: number; nickname: string; alive: boolean }
export interface WolfTeamView { seat: number; nickname: string; alive: boolean; suggestedSeat: number; selectedSeat: number }
export interface VoteResultView { kind: 'SHERIFF' | 'EXILE'; round: number; summary: string; totals: { seat: number; votes: number; voterSeats: number[]; sheriffVoterSeats: number[] }[]; abstainedSeats: number[] }
export interface MyActionView { type: NightStage | 'SHOOT'; targets: ActionTarget[]; submitted: boolean; teammates?: number[]; wolfTeam?: WolfTeamView[]; attackedSeat?: number; canSave?: boolean; canPoison?: boolean; result?: string }
export interface DayView { canExileVote?: boolean; canDuel?: boolean; shooterSeat?: number; stage: DayStage; voteResults?: VoteResultView[]; voteRound?: number; pkCandidates?: number[]; myVoteWeight?: number; candidates: number[]; sheriffSeat: number; speakerSeat: number; speechDeadline: number; direction: 'ASC' | 'DESC'; submitted: boolean; resultText: string; canChooseOrder: boolean; canFinishSpeech: boolean; canSheriffVote?: boolean; canWithdraw?: boolean; withdrawnSeats?: number[]; speechExtensionsRemaining?: number; canExplode: boolean; nextAfterResult?: string; targets: ActionTarget[] }
export interface VoteHistoryView extends VoteResultView { day: number }
export interface SheriffElectionView { day: number; signedSeats: number[]; withdrawnSeats: number[]; candidateSeats: number[]; completed: boolean; interrupted?: boolean; sheriffSeat: number }
export interface GameView { sheriffElection?: SheriffElectionView | null; skillHistory?: { day: number; text: string }[]; voteHistory?: VoteHistoryView[]; id: string; phase: Phase; nightStage?: NightStage | ''; stageReadyAt?: number; serverTime?: number; nightCue?: 'START' | 'OPEN' | 'ACTION' | 'CLOSE' | ''; day: number; version: number; waiting: boolean; confirmedCount: number; totalCount: number; myConfirmed: boolean; confirmationRequired?: boolean; resultPending: boolean; publicResult: number[]; winner: string; myRole?: MyRoleView; myAction?: MyActionView; dayView?: DayView }
export interface RoomView { id: string; code: string; ownerId: string; broadcast: { userId: string; nickname: string; version: number; online: boolean }; status: 'WAITING' | 'PLAYING' | 'FINISHED'; config: RoomConfig; members: MemberView[]; version: number; game?: GameView }
export interface SessionView { profile: ProfileView; room: RoomView | null }
export interface NoteView { revision?: number; targetSeat: number; kind?: 'player' | 'summary' | 'relations'; edges?: RelationEdge[]; roleGuess?: string; roleGuesses?: string[]; freeText?: string; voteText?: string; tendency: string; tags: string[]; text: string }

// Public and personal snapshots share a manifest, while unchanged personal data
// retains its own revision instead of being rewritten on every public change.
export type SubscriptionGame = Partial<Omit<GameView, 'dayView'>> & { dayView?: Partial<DayView> }
export interface PublicRoomStateDocument { _id: string; roomId: string; revision: number; privateVersions: { [userId: string]: number }; publishedAt: number; state: Omit<RoomView, 'game'> & { game?: SubscriptionGame } }
export interface PersonalRoomStateDocument { _id: string; roomId: string; protocol: number; revision: number; version: number; broadcastVersion: number; state?: { game: SubscriptionGame } | null }

export interface RelationEdge { source: number; target: number; type: 'ATTACK' | 'SUPPORT' }
