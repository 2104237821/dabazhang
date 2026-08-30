import type {
  ClientCommand,
  CommandAck,
  GameCommandType,
  GameViewState,
  LegalActionView
} from "@dabazhang/protocol";

export interface GameClient {
  sendCommand(command: ClientCommand): Promise<CommandAck>;
}

export type ConnectionState = "connected" | "reconnecting" | "disconnected";
export type RequestIdFactory = () => string;

export type GameIntent =
  | { type: "game:attack"; cardId: string }
  | { type: "game:pass-attack" }
  | { type: "game:defend"; attackId: string; cardId: string }
  | { type: "game:take" }
  | { type: "game:stop-attack" }
  | { type: "game:assist-propose"; cardId: string }
  | { type: "game:assist-decide"; proposalId: string; accepted: boolean }
  | { type: "game:exchange-trump-two" }
  | { type: "game:decline-trump-two" }
  | { type: "match:play-again" };

export type SubmissionState =
  | { status: "idle" }
  | { status: "pending"; requestId: string; expectedRevision: number }
  | { status: "acknowledged"; requestId: string; expectedRevision: number }
  | { status: "error"; message: string; requestId?: string };

export interface InteractionState {
  revision: number;
  selectedCardId?: string;
  selectedAttackId?: string;
  submission: SubmissionState;
}

export interface PreparedCommand {
  state: InteractionState;
  command?: ClientCommand;
}

export interface RequestIdCrypto {
  randomUUID?: () => string;
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

const ownCardActionTypes = new Set<GameCommandType>([
  "game:attack",
  "game:defend",
  "game:assist-propose"
]);

export function createRequestId(source: RequestIdCrypto = globalThis.crypto): string {
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export const defaultRequestIdFactory: RequestIdFactory = () => createRequestId();

export function createInteractionState(revision: number): InteractionState {
  return { revision, submission: { status: "idle" } };
}

export function getLegalAction(game: GameViewState, type: GameCommandType): LegalActionView | undefined {
  return game.legalActions.find((action) => action.type === type);
}

export function getInteractiveCardIds(game: GameViewState): Set<string> {
  return new Set(
    game.legalActions
      .filter((action) => ownCardActionTypes.has(action.type))
      .flatMap((action) => action.cardIds ?? [])
  );
}

export function getDefendableAttackIds(game: GameViewState): Set<string> {
  const legalIds = new Set(getLegalAction(game, "game:defend")?.attackIds ?? []);
  return new Set(
    game.table
      .filter((pair) => pair.defense === undefined && legalIds.has(pair.attackId))
      .map((pair) => pair.attackId)
  );
}

export function isSubmissionLocked(submission: SubmissionState): boolean {
  return submission.status === "pending" || submission.status === "acknowledged";
}

export function submissionMessage(submission: SubmissionState): string {
  if (submission.status === "pending") return "正在发送操作…";
  if (submission.status === "acknowledged") return "服务器已确认，等待最新牌桌状态…";
  if (submission.status === "error") return submission.message;
  return "";
}

export function selectCard(state: InteractionState, game: GameViewState, cardId: string): InteractionState {
  if (isSubmissionLocked(state.submission) || !getInteractiveCardIds(game).has(cardId)) return state;
  if (state.selectedCardId === cardId) {
    return {
      revision: state.revision,
      submission: state.submission,
      ...(state.selectedAttackId === undefined ? {} : { selectedAttackId: state.selectedAttackId })
    };
  }
  return { ...state, selectedCardId: cardId };
}

export function selectDefenseTarget(
  state: InteractionState,
  game: GameViewState,
  attackId: string
): InteractionState {
  if (isSubmissionLocked(state.submission) || !getDefendableAttackIds(game).has(attackId)) return state;
  if (state.selectedAttackId === attackId) {
    return {
      revision: state.revision,
      submission: state.submission,
      ...(state.selectedCardId === undefined ? {} : { selectedCardId: state.selectedCardId })
    };
  }
  return { ...state, selectedAttackId: attackId };
}

export function isIntentLegal(game: GameViewState, intent: GameIntent): boolean {
  if (intent.type === "match:play-again") return game.phase === "finished" && game.winner !== undefined;

  const action = getLegalAction(game, intent.type);
  if (action === undefined) return false;

  switch (intent.type) {
    case "game:attack":
    case "game:assist-propose":
      return action.cardIds?.includes(intent.cardId) === true;
    case "game:defend":
      return action.cardIds?.includes(intent.cardId) === true
        && getDefendableAttackIds(game).has(intent.attackId);
    case "game:assist-decide":
      return game.assistProposal?.proposalId === intent.proposalId
        && (action.attackIds === undefined || action.attackIds.includes(intent.proposalId));
    case "game:pass-attack":
    case "game:take":
    case "game:stop-attack":
    case "game:exchange-trump-two":
    case "game:decline-trump-two":
      return true;
  }
}

export function buildClientCommand(intent: GameIntent, revision: number, requestId: string): ClientCommand {
  switch (intent.type) {
    case "game:attack":
      return { requestId, expectedRevision: revision, type: intent.type, payload: { cardId: intent.cardId } };
    case "game:pass-attack":
    case "game:take":
    case "game:stop-attack":
    case "game:exchange-trump-two":
    case "game:decline-trump-two":
      return { requestId, expectedRevision: revision, type: intent.type, payload: {} };
    case "game:defend":
      return {
        requestId,
        expectedRevision: revision,
        type: intent.type,
        payload: { attackId: intent.attackId, cardId: intent.cardId }
      };
    case "game:assist-propose":
      return { requestId, expectedRevision: revision, type: intent.type, payload: { cardId: intent.cardId } };
    case "game:assist-decide":
      return {
        requestId,
        expectedRevision: revision,
        type: intent.type,
        payload: { proposalId: intent.proposalId, accepted: intent.accepted }
      };
    case "match:play-again":
      return { requestId, type: intent.type, payload: {} };
  }
}

export function prepareGameCommand(
  game: GameViewState,
  state: InteractionState,
  intent: GameIntent,
  requestId: string
): PreparedCommand {
  if (isSubmissionLocked(state.submission)) return { state };
  if (state.revision !== game.revision) {
    return {
      state: { ...state, submission: { status: "error", message: "牌桌状态已更新，请重新选择后操作" } }
    };
  }
  if (!isIntentLegal(game, intent)) {
    return {
      state: { ...state, submission: { status: "error", message: "当前操作不合法，请按最新提示重新选择" } }
    };
  }

  const command = buildClientCommand(intent, game.revision, requestId);
  return {
    state: {
      ...state,
      submission: { status: "pending", requestId, expectedRevision: game.revision }
    },
    command
  };
}

export function applyCommandAck(state: InteractionState, ack: CommandAck): InteractionState {
  if (state.submission.status !== "pending" || state.submission.requestId !== ack.requestId) return state;
  if (!ack.ok) {
    return {
      ...state,
      submission: {
        status: "error",
        requestId: ack.requestId,
        message: ack.error?.message ?? "操作失败，请重试"
      }
    };
  }
  return {
    ...state,
    submission: {
      status: "acknowledged",
      requestId: ack.requestId,
      expectedRevision: state.submission.expectedRevision
    }
  };
}

export function applyTransportError(state: InteractionState, requestId: string, error: unknown): InteractionState {
  if (state.submission.status !== "pending" || state.submission.requestId !== requestId) return state;
  return {
    ...state,
    submission: {
      status: "error",
      requestId,
      message: error instanceof Error ? error.message : "网络操作失败，请重试"
    }
  };
}

export function reconcileGameSnapshot(state: InteractionState, game: GameViewState): InteractionState {
  if (game.revision <= state.revision) return state;
  return createInteractionState(game.revision);
}

export function getDecisionSecondsRemaining(deadline: number | undefined, currentServerTime: number): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(0, Math.ceil((deadline - currentServerTime) / 1000));
}

export function getPresenceNotice(game: GameViewState, connection: ConnectionState): string | null {
  if (connection === "reconnecting") return "连接中断，正在重连；恢复后会同步最新牌桌";
  if (connection === "disconnected") return "已与服务器断开，当前操作已暂停";
  const takeover = game.players.find((player) => player.controller === "bot-takeover");
  if (takeover !== undefined) return `${takeover.nickname}正由机器人接管，真人回来后将在安全决策边界收回控制`;
  const grace = game.players.find((player) => player.controller === "human-grace");
  if (grace !== undefined) return `${grace.nickname}已离线；轮到其操作时会等待重连`;
  return null;
}

export function getWinnerSummary(game: GameViewState): { title: string; detail: string } | undefined {
  if (game.phase !== "finished" || game.winner === undefined) return undefined;
  const selfTeam = game.players.find((player) => player.seatId === game.selfSeat)?.teamId;
  const ownTeamWon = selfTeam === game.winner;
  return {
    title: ownTeamWon ? "我方获胜" : "对方获胜",
    detail: `${ownTeamWon ? "蓝队" : "铜队"}两名队友已经正式出完`
  };
}
