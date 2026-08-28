import { createHash, randomBytes, randomInt } from "node:crypto";

import { chooseBotCommand } from "@dabazhang/bot";
import {
  buildPlayerView as buildCorePlayerView,
  createInitialGame,
  createNextHand,
  dispatch,
  isTrump,
  teamForSeat,
  type Card,
  type GameCommand,
  type GameState,
  type LegalAction,
  type PlayerView as CorePlayerView,
  type RandomSource
} from "@dabazhang/game-core";
import type {
  AttackPairView,
  CardView,
  ClientCommand,
  CommandErrorCode,
  GameViewState,
  LegalActionView,
  PlayerView,
  RoomView,
  SeatId,
  StateSnapshot,
  TeamId
} from "@dabazhang/protocol";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_ROOM_CODE_ATTEMPTS = 1_000;
const DEFAULT_DECISION_TIMEOUT_MS = 45_000;
const DEFAULT_DISCONNECT_GRACE_MS = 60_000;

type GameClientCommand = Extract<ClientCommand, { type: `game:${string}` }>;
type HumanController = "human" | "human-grace" | "bot-takeover";
type TimerHandle = ReturnType<typeof setTimeout>;

interface HumanSeat {
  readonly kind: "human";
  readonly seatId: SeatId;
  readonly sessionId: string;
  readonly nickname: string;
  readonly joinedOrder: number;
  ready: boolean;
  online: boolean;
  controller: HumanController;
  graceDeadline?: number;
  graceTimer?: TimerHandle;
}

interface BotSeat {
  readonly kind: "bot";
  readonly seatId: SeatId;
  readonly nickname: string;
  readonly joinedOrder: number;
}

type RoomSeat = HumanSeat | BotSeat;

interface GuestSession {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly roomCode: string;
  readonly seatId: SeatId;
  socketId?: string;
}

interface PendingDecision {
  readonly key: string;
  readonly seatId: SeatId;
  readonly mode: "human-timeout" | "bot";
  readonly timer: TimerHandle;
  readonly deadline?: number;
}

interface RoomState {
  readonly roomCode: string;
  readonly seats: Array<RoomSeat | undefined>;
  status: RoomView["status"];
  hostSeat: SeatId;
  revision: number;
  game?: GameState;
  decision?: PendingDecision;
}

export interface StartGameSeat {
  seatId: SeatId;
  teamId: TeamId;
  nickname: string;
  controller: "human" | "bot-fixed";
}

export interface StartGameContext {
  roomCode: string;
  seats: [StartGameSeat, StartGameSeat, StartGameSeat, StartGameSeat];
}

export type StartGameHandler = (context: StartGameContext) => Promise<void> | void;
export type RoomChangedHandler = (roomCode: string) => Promise<void> | void;

export interface RoomManagerOptions {
  startGame?: StartGameHandler;
  codeGenerator?: () => string;
  tokenGenerator?: () => string;
  now?: () => number;
  rng?: RandomSource;
  botDelayMs?: () => number;
  decisionTimeoutMs?: number;
  disconnectGraceMs?: number;
  roomChanged?: RoomChangedHandler;
}

export interface RoomMutationResult {
  roomCode: string;
  revision?: number;
  resumeToken?: string;
  replacedSocketId?: string;
}

export interface SocketSnapshot {
  socketId: string;
  snapshot: StateSnapshot;
}

export class RoomCommandError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RoomCommandError";
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomState>();
  private readonly sessionsByToken = new Map<string, GuestSession>();
  private readonly sessionIdsBySocket = new Map<string, string>();
  private readonly sessionsById = new Map<string, GuestSession>();
  private readonly roomQueues = new Map<string, Promise<void>>();
  private readonly startGame: StartGameHandler;
  private readonly codeGenerator: () => string;
  private readonly tokenGenerator: () => string;
  private readonly now: () => number;
  private readonly rng: RandomSource;
  private readonly botDelayMs: () => number;
  private readonly decisionTimeoutMs: number;
  private readonly disconnectGraceMs: number;
  private roomChanged: RoomChangedHandler;
  private joinedOrder = 0;
  private closed = false;

  constructor(options: RoomManagerOptions = {}) {
    this.startGame = options.startGame ?? (() => undefined);
    this.codeGenerator = options.codeGenerator ?? generateRoomCode;
    this.tokenGenerator = options.tokenGenerator ?? generateResumeToken;
    this.now = options.now ?? Date.now;
    this.rng = options.rng ?? secureRandom;
    this.botDelayMs = options.botDelayMs ?? (() => randomInt(500, 901));
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.disconnectGraceMs = options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
    this.roomChanged = options.roomChanged ?? (() => undefined);
  }

  setRoomChangedHandler(handler: RoomChangedHandler): void {
    this.roomChanged = handler;
  }

  async createRoom(socketId: string, nicknameInput: string): Promise<RoomMutationResult> {
    this.assertOpen();
    this.assertSocketIsFree(socketId);
    const nickname = normalizeNickname(nicknameInput);
    const roomCode = this.createUniqueRoomCode();
    const resumeToken = this.tokenGenerator();
    const session = this.createSession(roomCode, 0, socketId, resumeToken);
    const host: HumanSeat = {
      kind: "human",
      seatId: 0,
      sessionId: session.sessionId,
      nickname,
      joinedOrder: this.nextJoinedOrder(),
      ready: false,
      online: true,
      controller: "human"
    };
    const room: RoomState = {
      roomCode,
      seats: [host, undefined, undefined, undefined],
      status: "lobby",
      hostSeat: 0,
      revision: 1
    };
    this.rooms.set(roomCode, room);
    return { roomCode, revision: room.revision, resumeToken };
  }

  async joinRoom(socketId: string, roomCodeInput: string, nicknameInput: string): Promise<RoomMutationResult> {
    this.assertOpen();
    this.assertSocketIsFree(socketId);
    const roomCode = normalizeRoomCode(roomCodeInput);
    return this.enqueue(roomCode, () => {
      this.assertSocketIsFree(socketId);
      const room = this.requireRoom(roomCode);
      this.assertLobby(room);
      const nickname = normalizeNickname(nicknameInput);
      this.assertNicknameAvailable(room, nickname);
      const seatId = findOpenSeat(room);
      if (seatId === undefined) throw new RoomCommandError("ROOM_FULL", "房间已经坐满了");
      const resumeToken = this.tokenGenerator();
      const session = this.createSession(roomCode, seatId, socketId, resumeToken);
      room.seats[seatId] = {
        kind: "human",
        seatId,
        sessionId: session.sessionId,
        nickname,
        joinedOrder: this.nextJoinedOrder(),
        ready: false,
        online: true,
        controller: "human"
      };
      room.revision += 1;
      return { roomCode, revision: room.revision, resumeToken };
    });
  }

  async resumeRoom(socketId: string, roomCodeInput: string, resumeToken: string): Promise<RoomMutationResult> {
    this.assertOpen();
    this.assertSocketIsFree(socketId);
    const roomCode = normalizeRoomCode(roomCodeInput);
    const tokenHash = hashToken(resumeToken);
    return this.enqueue(roomCode, () => {
      this.assertSocketIsFree(socketId);
      const room = this.rooms.get(roomCode);
      if (room === undefined) {
        throw new RoomCommandError("SERVER_RESTARTED", "原房间已结束，服务器可能已经重启");
      }
      const session = this.sessionsByToken.get(tokenHash);
      if (session === undefined || session.roomCode !== roomCode) {
        throw new RoomCommandError("ROOM_NOT_FOUND", "房间或恢复凭证无效");
      }
      const seat = room.seats[session.seatId];
      if (seat?.kind !== "human" || seat.sessionId !== session.sessionId) {
        throw new RoomCommandError("ROOM_NOT_FOUND", "该玩家座位已经不存在");
      }
      const replacedSocketId = session.socketId;
      if (replacedSocketId !== undefined) this.sessionIdsBySocket.delete(replacedSocketId);
      session.socketId = socketId;
      this.sessionIdsBySocket.set(socketId, session.sessionId);
      this.clearGraceTimer(seat);

      let presenceChanged = !seat.online;
      seat.online = true;
      if (seat.controller === "human-grace") {
        seat.controller = "human";
        presenceChanged = true;
      } else if (seat.controller === "bot-takeover") {
        if (room.decision?.seatId === seat.seatId && room.decision.mode === "bot") {
          this.clearDecision(room);
        }
        seat.controller = "human";
        presenceChanged = true;
      }
      if (presenceChanged) room.revision += 1;
      this.reconcileDecision(room);
      return {
        roomCode,
        revision: room.revision,
        ...(replacedSocketId !== undefined && replacedSocketId !== socketId ? { replacedSocketId } : {})
      };
    });
  }

  async setReady(socketId: string, ready: boolean): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      this.assertLobby(room);
      if (seat.ready !== ready) {
        seat.ready = ready;
        room.revision += 1;
      }
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async addBot(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      this.assertLobby(room);
      this.assertHost(room, seat.seatId);
      const seatId = findOpenSeat(room);
      if (seatId === undefined) throw new RoomCommandError("ROOM_FULL", "房间已经坐满了");
      room.seats[seatId] = this.createBotSeat(room, seatId);
      room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async removeBot(socketId: string, seatId: SeatId): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      this.assertLobby(room);
      this.assertHost(room, seat.seatId);
      if (room.seats[seatId]?.kind !== "bot") {
        throw new RoomCommandError("ILLEGAL_ACTION", "该座位不是机器人");
      }
      room.seats[seatId] = undefined;
      room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async fillBots(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      this.assertLobby(room);
      this.assertHost(room, seat.seatId);
      let added = false;
      for (const seatId of [0, 1, 2, 3] as const) {
        if (room.seats[seatId] === undefined) {
          room.seats[seatId] = this.createBotSeat(room, seatId);
          added = true;
        }
      }
      if (added) room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async startRoom(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, async ({ room, seat }) => {
      this.assertLobby(room);
      this.assertHost(room, seat.seatId);
      if (room.seats.some((candidate) => candidate === undefined)) {
        throw new RoomCommandError("NOT_READY", "需要四个座位全部有人或机器人才能开始");
      }
      if (room.seats.some((candidate) => candidate?.kind === "human" && candidate.controller !== "bot-takeover" && !candidate.ready)) {
        throw new RoomCommandError("NOT_READY", "所有真人玩家准备后才能开始");
      }
      const seats = room.seats.map((candidate) => {
        if (candidate === undefined) throw new RoomCommandError("NOT_READY", "座位尚未坐满");
        return {
          seatId: candidate.seatId,
          teamId: teamForSeat(candidate.seatId),
          nickname: candidate.nickname,
          controller: candidate.kind === "bot" ? "bot-fixed" : "human"
        } satisfies StartGameSeat;
      }) as StartGameContext["seats"];
      await this.startGame({ roomCode: room.roomCode, seats });
      room.game = createInitialGame({ rng: this.rng });
      room.status = "playing";
      room.revision += 1;
      this.reconcileDecision(room);
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async executeGameCommand(socketId: string, command: GameClientCommand): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      if (room.status !== "playing" || room.game === undefined) {
        throw new RoomCommandError("ILLEGAL_ACTION", "当前房间没有进行中的牌局");
      }
      if (!seat.online || seat.controller !== "human") {
        throw new RoomCommandError("NOT_YOUR_TURN", "当前座位正由机器人控制");
      }
      if (command.expectedRevision !== room.revision) {
        throw new RoomCommandError("STALE_REVISION", `当前修订号为 ${room.revision}`);
      }
      const applied = dispatch(room.game, toCoreCommand(command, seat.seatId, room.game.revision));
      if (!applied.ok) throw ruleErrorToRoomError(applied.error.code, applied.error.message);
      this.clearDecision(room);
      room.game = applied.value.state;
      room.revision += 1;
      if (room.game.phase.type === "finished") room.status = "post-game";
      this.reconcileDecision(room);
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async playAgain(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      if (room.status !== "post-game" || room.game === undefined) {
        throw new RoomCommandError("ILLEGAL_ACTION", "当前牌局尚未结束");
      }
      this.assertHost(room, seat.seatId);
      this.clearDecision(room);
      room.game = createNextHand(room.game, this.rng);
      room.status = "playing";
      room.revision += 1;
      this.reconcileDecision(room);
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async leaveRoom(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat, session }) => {
      if (room.status !== "lobby") {
        this.clearGraceTimer(seat);
        this.removeSession(session);
        seat.online = false;
        seat.controller = "bot-takeover";
        room.revision += 1;
        this.transferHost(room, seat.seatId);
        this.reconcileDecision(room);
        return { roomCode: room.roomCode, revision: room.revision };
      }
      this.clearGraceTimer(seat);
      this.removeSession(session);
      room.seats[seat.seatId] = undefined;
      if (this.humanSeats(room).length === 0) {
        this.deleteRoom(room);
        return { roomCode: room.roomCode };
      }
      this.transferHost(room, seat.seatId);
      room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async disconnect(socketId: string): Promise<RoomMutationResult | undefined> {
    if (this.closed) return undefined;
    const session = this.getSessionForSocket(socketId);
    if (session === undefined) return undefined;
    return this.enqueue(session.roomCode, () => {
      const currentSession = this.sessionsById.get(session.sessionId);
      if (currentSession?.socketId !== socketId) return undefined;
      const room = this.rooms.get(session.roomCode);
      const seat = room?.seats[session.seatId];
      this.sessionIdsBySocket.delete(socketId);
      delete currentSession.socketId;
      if (room === undefined || seat?.kind !== "human") return undefined;
      seat.online = false;
      seat.controller = "human-grace";
      this.scheduleGraceTimer(room, seat);
      room.revision += 1;
      this.reconcileDecision(room);
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  getConnectedSnapshots(roomCodeInput: string): SocketSnapshot[] {
    const room = this.rooms.get(normalizeRoomCode(roomCodeInput));
    if (room === undefined) return [];
    const snapshots: SocketSnapshot[] = [];
    for (const seat of room.seats) {
      if (seat?.kind !== "human") continue;
      const session = this.sessionsById.get(seat.sessionId);
      if (session?.socketId === undefined) continue;
      snapshots.push({ socketId: session.socketId, snapshot: this.buildSnapshot(room, seat.seatId) });
    }
    return snapshots;
  }

  getSnapshotForSocket(socketId: string, resumeToken?: string): StateSnapshot {
    const session = this.requireSessionForSocket(socketId);
    return this.buildSnapshot(this.requireRoom(session.roomCode), session.seatId, resumeToken);
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const room of this.rooms.values()) {
      this.clearDecision(room);
      for (const seat of room.seats) if (seat?.kind === "human") this.clearGraceTimer(seat);
    }
  }

  private async withHumanSeat<T>(socketId: string, operation: (context: { room: RoomState; seat: HumanSeat; session: GuestSession }) => Promise<T> | T): Promise<T> {
    this.assertOpen();
    const initialSession = this.requireSessionForSocket(socketId);
    return this.enqueue(initialSession.roomCode, () => {
      const session = this.requireSessionForSocket(socketId);
      const room = this.requireRoom(session.roomCode);
      const seat = room.seats[session.seatId];
      if (seat?.kind !== "human" || seat.sessionId !== session.sessionId) {
        throw new RoomCommandError("NOT_IN_ROOM", "当前连接没有有效玩家座位");
      }
      return operation({ room, seat, session });
    });
  }

  private buildSnapshot(room: RoomState, selfSeat: SeatId, resumeToken?: string): StateSnapshot {
    const players = this.buildRoomPlayers(room, selfSeat);
    const roomView: RoomView = { roomCode: room.roomCode, status: room.status, hostSeat: room.hostSeat, selfSeat, players };
    return {
      revision: room.revision,
      serverTime: this.now(),
      room: roomView,
      ...(room.game === undefined ? {} : { game: this.buildGameView(room, selfSeat, players) }),
      ...(resumeToken === undefined ? {} : { resumeToken })
    };
  }

  private buildRoomPlayers(room: RoomState, selfSeat: SeatId): PlayerView[] {
    const coreView = room.game === undefined ? undefined : buildCorePlayerView(room.game, selfSeat);
    return room.seats.filter((seat): seat is RoomSeat => seat !== undefined).map((seat) => this.buildPlayerView(seat, coreView));
  }

  private buildPlayerView(seat: RoomSeat, coreView?: CorePlayerView): PlayerView {
    const observed = coreView?.players.find((player) => player.seatId === seat.seatId);
    const hand =
      observed?.hand === undefined || coreView === undefined
        ? undefined
        : observed.hand.map((card) => toCardView(card, coreView.trumpSuit));
    const gameFields = {
      handCount: observed?.handCount ?? 0,
      ...(hand === undefined ? {} : { hand }),
      ...(observed?.finishedPlace === undefined ? {} : { finishedPlace: observed.finishedPlace })
    };
    if (seat.kind === "bot") {
      return { seatId: seat.seatId, nickname: seat.nickname, teamId: teamForSeat(seat.seatId), ...gameFields, ready: true, online: true, controller: "bot-fixed" };
    }
    return { seatId: seat.seatId, nickname: seat.nickname, teamId: teamForSeat(seat.seatId), ...gameFields, ready: seat.ready, online: seat.online, controller: seat.controller };
  }

  private buildGameView(room: RoomState, selfSeat: SeatId, players: PlayerView[]): GameViewState {
    const state = room.game;
    if (state === undefined) throw new Error("A game view requires game state");
    const view = buildCorePlayerView(state, selfSeat);
    const deadline = this.visibleDecisionDeadline(room);
    const assistProposal =
      view.phase.type === "await-assist-approval" ? view.phase.proposal : undefined;
    const assistCard =
      assistProposal === undefined ? undefined : state.cardsById[assistProposal.cardId];
    return {
      revision: room.revision,
      phase: toProtocolPhase(view.phase.type),
      selfSeat,
      trumpSuit: view.trumpSuit,
      ...(view.bottomCard === undefined ? {} : { bottomCard: toCardView(view.bottomCard, view.trumpSuit) }),
      drawPileCount: view.drawPileCount,
      mainTwoSwapAvailable: view.mainTwoSwapAvailable,
      primaryAttacker: view.primaryAttacker,
      defender: view.defender,
      players,
      table: view.table.map((pair): AttackPairView => ({
        attackId: pair.attackId,
        attacker: pair.attack.player,
        attack: toCardView(pair.attack.card, view.trumpSuit),
        ...(pair.defense === undefined ? {} : { defense: toCardView(pair.defense.card, view.trumpSuit) })
      })),
      ...(assistProposal === undefined || assistCard === undefined
        ? {}
        : {
            assistProposal: {
              proposalId: assistProposal.proposalId,
              proposer: assistProposal.player,
              card: toCardView(assistCard, view.trumpSuit)
            }
          }),
      finishedOrder: [...view.finishedOrder],
      ...(view.winner === undefined ? {} : { winner: view.winner }),
      legalActions: view.legalActions.map((action) => toLegalActionView(action, view)),
      ...(deadline === undefined ? {} : { decisionDeadline: deadline }),
      message: describePhase(view)
    };
  }

  private visibleDecisionDeadline(room: RoomState): number | undefined {
    if (room.decision?.deadline !== undefined) return room.decision.deadline;
    const actor = room.game === undefined ? undefined : mandatoryDecisionSeat(room.game);
    const seat = actor === undefined ? undefined : room.seats[actor];
    return seat?.kind === "human" && seat.controller === "human-grace" ? seat.graceDeadline : undefined;
  }

  private scheduleGraceTimer(room: RoomState, seat: HumanSeat): void {
    this.clearGraceTimer(seat);
    const deadline = this.now() + this.disconnectGraceMs;
    seat.graceDeadline = deadline;
    seat.graceTimer = setTimeout(() => {
      void this.enqueue(room.roomCode, () => {
        const currentRoom = this.rooms.get(room.roomCode);
        const currentSeat = currentRoom?.seats[seat.seatId];
        if (currentRoom === undefined || currentSeat?.kind !== "human" || currentSeat.online || currentSeat.controller !== "human-grace" || currentSeat.graceDeadline !== deadline) return;
        this.clearGraceTimer(currentSeat);
        currentSeat.controller = "bot-takeover";
        this.transferHost(currentRoom, currentSeat.seatId);
        currentRoom.revision += 1;
        this.reconcileDecision(currentRoom);
        this.notifyRoomChanged(currentRoom.roomCode);
      });
    }, this.disconnectGraceMs);
  }

  private clearGraceTimer(seat: HumanSeat): void {
    if (seat.graceTimer !== undefined) clearTimeout(seat.graceTimer);
    delete seat.graceTimer;
    delete seat.graceDeadline;
  }

  private reconcileDecision(room: RoomState): void {
    if (room.status !== "playing" || room.game === undefined) {
      this.clearDecision(room);
      return;
    }
    const seatId = mandatoryDecisionSeat(room.game);
    const seat = seatId === undefined ? undefined : room.seats[seatId];
    if (seatId === undefined || seat === undefined) {
      this.clearDecision(room);
      return;
    }
    const mode = seat.kind === "bot" || seat.controller === "bot-takeover" ? "bot" : seat.controller === "human" && seat.online ? "human-timeout" : undefined;
    if (mode === undefined) {
      this.clearDecision(room);
      return;
    }
    const key = `${room.game.revision}:${seatId}:${room.game.phase.type}:${mode}`;
    if (room.decision?.key === key) return;
    this.clearDecision(room);
    const delay = mode === "bot" ? normalizeDelay(this.botDelayMs()) : this.decisionTimeoutMs;
    const deadline = mode === "human-timeout" ? this.now() + delay : undefined;
    const timer = setTimeout(() => void this.executeScheduledDecision(room.roomCode, key), delay);
    room.decision = { key, seatId, mode, timer, ...(deadline === undefined ? {} : { deadline }) };
  }

  private async executeScheduledDecision(roomCode: string, key: string): Promise<void> {
    await this.enqueue(roomCode, () => {
      const room = this.rooms.get(roomCode);
      if (room?.decision?.key !== key || room.game === undefined || room.status !== "playing") return;
      const decision = room.decision;
      delete room.decision;
      const seat = room.seats[decision.seatId];
      if (seat === undefined) return;
      const botControlled = seat.kind === "bot" || seat.controller === "bot-takeover";
      const timedOutHuman = seat.kind === "human" && seat.online && seat.controller === "human";
      if ((decision.mode === "bot" && !botControlled) || (decision.mode === "human-timeout" && !timedOutHuman)) {
        this.reconcileDecision(room);
        return;
      }
      const command = chooseBotCommand(buildCorePlayerView(room.game, decision.seatId));
      if (command === undefined) {
        this.notifyRoomChanged(roomCode);
        return;
      }
      const applied = dispatch(room.game, command);
      if (!applied.ok) {
        this.notifyRoomChanged(roomCode);
        return;
      }
      room.game = applied.value.state;
      room.revision += 1;
      if (room.game.phase.type === "finished") room.status = "post-game";
      this.reconcileDecision(room);
      this.notifyRoomChanged(roomCode);
    });
  }

  private clearDecision(room: RoomState): void {
    if (room.decision !== undefined) clearTimeout(room.decision.timer);
    delete room.decision;
  }

  private notifyRoomChanged(roomCode: string): void {
    if (!this.closed) void Promise.resolve(this.roomChanged(roomCode));
  }

  private createSession(roomCode: string, seatId: SeatId, socketId: string, resumeToken: string): GuestSession {
    const tokenHash = hashToken(resumeToken);
    if (this.sessionsByToken.has(tokenHash)) throw new RoomCommandError("BAD_REQUEST", "无法创建唯一恢复凭证，请重试");
    const session: GuestSession = { sessionId: randomBytes(16).toString("base64url"), tokenHash, roomCode, seatId, socketId };
    this.sessionsByToken.set(tokenHash, session);
    this.sessionsById.set(session.sessionId, session);
    this.sessionIdsBySocket.set(socketId, session.sessionId);
    return session;
  }

  private removeSession(session: GuestSession): void {
    this.sessionsByToken.delete(session.tokenHash);
    this.sessionsById.delete(session.sessionId);
    if (session.socketId !== undefined) this.sessionIdsBySocket.delete(session.socketId);
  }

  private createBotSeat(room: RoomState, seatId: SeatId): BotSeat {
    const baseNickname = `机器人${seatId + 1}`;
    let nickname = baseNickname;
    let suffix = 2;
    while (this.nicknameExists(room, nickname)) {
      nickname = `${baseNickname}-${suffix}`;
      suffix += 1;
    }
    return { kind: "bot", seatId, nickname, joinedOrder: this.nextJoinedOrder() };
  }

  private transferHost(room: RoomState, departedSeat: SeatId): void {
    if (room.hostSeat !== departedSeat) return;
    const remaining = this.humanSeats(room).filter(
      (seat) => seat.seatId !== departedSeat && this.sessionsById.has(seat.sessionId)
    );
    remaining.sort((left, right) => left.joinedOrder - right.joinedOrder);
    const nextHost = remaining[0];
    if (nextHost !== undefined) room.hostSeat = nextHost.seatId;
  }

  private humanSeats(room: RoomState): HumanSeat[] {
    return room.seats.filter((candidate): candidate is HumanSeat => candidate?.kind === "human");
  }

  private deleteRoom(room: RoomState): void {
    this.clearDecision(room);
    for (const seat of this.humanSeats(room)) this.clearGraceTimer(seat);
    this.rooms.delete(room.roomCode);
    this.roomQueues.delete(room.roomCode);
  }

  private assertOpen(): void {
    if (this.closed) throw new RoomCommandError("SERVER_RESTARTED", "服务器正在关闭");
  }

  private assertSocketIsFree(socketId: string): void {
    if (this.sessionIdsBySocket.has(socketId)) throw new RoomCommandError("BAD_REQUEST", "当前连接已经加入房间");
  }

  private assertNicknameAvailable(room: RoomState, nickname: string): void {
    if (this.nicknameExists(room, nickname)) throw new RoomCommandError("NICKNAME_TAKEN", "该昵称已在房间中使用");
  }

  private nicknameExists(room: RoomState, nickname: string): boolean {
    const key = nicknameKey(nickname);
    return room.seats.some((seat) => seat !== undefined && nicknameKey(seat.nickname) === key);
  }

  private assertLobby(room: RoomState): void {
    if (room.status !== "lobby") throw new RoomCommandError("GAME_ALREADY_STARTED", "游戏已经开始");
  }

  private assertHost(room: RoomState, seatId: SeatId): void {
    if (room.hostSeat !== seatId) throw new RoomCommandError("NOT_HOST", "只有房主可以执行该操作");
  }

  private requireRoom(roomCode: string): RoomState {
    const room = this.rooms.get(roomCode);
    if (room === undefined) throw new RoomCommandError("ROOM_NOT_FOUND", "房间不存在");
    return room;
  }

  private getSessionForSocket(socketId: string): GuestSession | undefined {
    const sessionId = this.sessionIdsBySocket.get(socketId);
    return sessionId === undefined ? undefined : this.sessionsById.get(sessionId);
  }

  private requireSessionForSocket(socketId: string): GuestSession {
    const session = this.getSessionForSocket(socketId);
    if (session === undefined) throw new RoomCommandError("NOT_IN_ROOM", "当前连接尚未加入房间");
    return session;
  }

  private createUniqueRoomCode(): string {
    for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
      const candidate = normalizeRoomCode(this.codeGenerator());
      if (/^[A-HJ-NP-Z2-9]{6}$/.test(candidate) && !this.rooms.has(candidate)) return candidate;
    }
    throw new RoomCommandError("BAD_REQUEST", "暂时无法分配房间码，请稍后重试");
  }

  private nextJoinedOrder(): number {
    this.joinedOrder += 1;
    return this.joinedOrder;
  }

  private enqueue<T>(roomCode: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.roomQueues.get(roomCode) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.roomQueues.set(roomCode, tail);
    void tail.finally(() => {
      if (this.roomQueues.get(roomCode) === tail) this.roomQueues.delete(roomCode);
    });
    return result;
  }
}

function toCoreCommand(command: GameClientCommand, actor: SeatId, expectedRevision: number): GameCommand {
  switch (command.type) {
    case "game:attack":
      return { type: "play-attack", actor, expectedRevision, cardId: command.payload.cardId };
    case "game:pass-attack":
      return { type: "pass-attack", actor, expectedRevision };
    case "game:defend":
      return { type: "play-defense", actor, expectedRevision, attackId: command.payload.attackId, cardId: command.payload.cardId };
    case "game:take":
      return { type: "collect-table", actor, expectedRevision };
    case "game:stop-attack":
      return { type: "stop-attack", actor, expectedRevision };
    case "game:assist-propose":
      return { type: "request-assist", actor, expectedRevision, cardId: command.payload.cardId };
    case "game:assist-decide":
      return { type: "decide-assist", actor, expectedRevision, proposalId: command.payload.proposalId, accepted: command.payload.accepted };
    case "game:exchange-trump-two":
      return { type: "exchange-trump-two", actor, expectedRevision };
    case "game:decline-trump-two":
      return { type: "decline-trump-two", actor, expectedRevision };
  }
}

function ruleErrorToRoomError(code: string, message: string): RoomCommandError {
  if (code === "stale-revision") return new RoomCommandError("STALE_REVISION", message);
  if (code === "not-your-turn") return new RoomCommandError("NOT_YOUR_TURN", message);
  if (["card-not-in-hand", "illegal-card", "illegal-defense", "illegal-assist", "assist-not-found", "main-two-unavailable", "wrong-phase", "game-finished"].includes(code)) {
    return new RoomCommandError("ILLEGAL_ACTION", message);
  }
  return new RoomCommandError("BAD_REQUEST", "规则引擎拒绝了当前状态");
}

function mandatoryDecisionSeat(state: GameState): SeatId | undefined {
  switch (state.phase.type) {
    case "await-opening-attack":
    case "await-continuation":
    case "await-assist-approval":
      return state.primaryAttacker;
    case "await-defense":
      return state.defender;
    case "await-main-two-decision":
      return state.phase.player;
    case "dealing":
    case "post-round-refill":
    case "finished":
      return undefined;
  }
}

function toProtocolPhase(phase: GameState["phase"]["type"]): GameViewState["phase"] {
  if (phase === "dealing") return "await-opening-attack";
  return phase;
}

function toCardView(card: Card, trumpSuit: GameState["trumpSuit"]): CardView {
  return { cardId: card.id, suit: card.suit, rank: card.rank, isTrump: isTrump(card, trumpSuit) };
}

function toLegalActionView(action: LegalAction, view: CorePlayerView): LegalActionView {
  switch (action.type) {
    case "play-attack":
      return { type: "game:attack", cardIds: [...action.cardIds] };
    case "pass-attack":
      return { type: "game:pass-attack" };
    case "play-defense":
      return { type: "game:defend", cardIds: [...action.cardIds], attackIds: [action.attackId] };
    case "collect-table":
      return { type: "game:take" };
    case "stop-attack":
      return { type: "game:stop-attack" };
    case "request-assist":
      return { type: "game:assist-propose", cardIds: [...action.cardIds] };
    case "decide-assist": {
      const proposal = view.phase.type === "await-assist-approval" ? view.phase.proposal : undefined;
      return { type: "game:assist-decide", attackIds: [action.proposalId], ...(proposal === undefined ? {} : { cardIds: [proposal.cardId] }) };
    }
    case "exchange-trump-two":
      return { type: "game:exchange-trump-two" };
    case "decline-trump-two":
      return { type: "game:decline-trump-two" };
  }
}

function describePhase(view: CorePlayerView): string {
  switch (view.phase.type) {
    case "dealing": return "正在发牌";
    case "await-opening-attack": return `等待 ${view.primaryAttacker} 号座位首攻`;
    case "await-defense": return `等待 ${view.defender} 号座位防守`;
    case "await-continuation": return `等待 ${view.primaryAttacker} 号座位追加或结束进攻`;
    case "await-assist-approval": return "等待主攻方审批协攻";
    case "await-main-two-decision": return `等待 ${view.phase.player} 号座位决定是否主2换底`;
    case "post-round-refill": return "正在补牌并结算本轮";
    case "finished": return view.winner === undefined ? "本局结束" : `${view.winner} 队获胜`;
  }
}

function normalizeRoomCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}

function normalizeNickname(nickname: string): string {
  const normalized = nickname.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 32 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new RoomCommandError("BAD_REQUEST", "昵称格式无效");
  }
  return normalized;
}

function nicknameKey(nickname: string): string {
  return nickname.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function generateResumeToken(): string {
  return randomBytes(32).toString("base64url");
}

function generateRoomCode(): string {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

function secureRandom(): number {
  return randomInt(0x1_0000_0000) / 0x1_0000_0000;
}

function normalizeDelay(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 500;
}

function findOpenSeat(room: RoomState): SeatId | undefined {
  return ([0, 1, 2, 3] as const).find((seatId) => room.seats[seatId] === undefined);
}
