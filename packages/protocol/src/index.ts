import { z } from "zod";

export const suits = ["spade", "heart", "club", "diamond"] as const;
export const ranks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, "smallJoker", "bigJoker"] as const;
export const seatIds = [0, 1, 2, 3] as const;

export type Suit = (typeof suits)[number];
export type Rank = (typeof ranks)[number];
export type SeatId = (typeof seatIds)[number];
export type TeamId = 0 | 1;

export interface CardView {
  cardId: string;
  suit: Suit | "joker";
  rank: Rank;
  isTrump: boolean;
}

export interface PlayerView {
  seatId: SeatId;
  nickname: string;
  teamId: TeamId;
  handCount: number;
  hand?: CardView[];
  ready: boolean;
  online: boolean;
  controller: "human" | "human-grace" | "bot-takeover" | "bot-fixed";
  finishedPlace?: number;
}

export interface AttackPairView {
  attackId: string;
  attacker: SeatId;
  attack: CardView;
  defense?: CardView;
}

export interface AssistProposalView {
  proposalId: string;
  proposer: SeatId;
  card: CardView;
}

export type GamePhase =
  | "await-opening-attack"
  | "await-defense"
  | "await-continuation"
  | "await-assist-approval"
  | "await-main-two-decision"
  | "post-round-refill"
  | "finished";

export interface LegalActionView {
  type: GameCommandType;
  cardIds?: string[];
  attackIds?: string[];
}

export interface GameViewState {
  revision: number;
  phase: GamePhase;
  selfSeat: SeatId;
  trumpSuit: Suit;
  bottomCard?: CardView;
  drawPileCount: number;
  mainTwoSwapAvailable: boolean;
  primaryAttacker: SeatId;
  defender: SeatId;
  players: PlayerView[];
  table: AttackPairView[];
  /** Only present in the primary attacker's sanitized view. */
  assistProposal?: AssistProposalView;
  finishedOrder: SeatId[];
  winner?: TeamId;
  legalActions: LegalActionView[];
  decisionDeadline?: number;
  message: string;
}

export interface RoomView {
  roomCode: string;
  status: "lobby" | "playing" | "post-game";
  hostSeat: SeatId;
  selfSeat: SeatId;
  players: PlayerView[];
}

export interface StateSnapshot {
  revision: number;
  serverTime: number;
  room: RoomView;
  game?: GameViewState;
  resumeToken?: string;
}

const requestId = z.string().uuid();
const nickname = z.string().trim().min(1).max(32);
const roomCode = z.string().regex(/^[A-HJ-NP-Z2-9]{6}$/);
const cardId = z.string().min(1).max(64);
const attackId = z.string().min(1).max(64);
const expectedRevision = z.number().int().nonnegative();

const commandBase = { requestId } as const;
const gameBase = { requestId, expectedRevision } as const;

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...commandBase, type: z.literal("room:create"), payload: z.object({ nickname }).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("room:join"), payload: z.object({ roomCode, nickname }).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("room:resume"), payload: z.object({ roomCode, resumeToken: z.string().min(32).max(256) }).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("room:ready"), payload: z.object({ ready: z.boolean() }).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("room:add-bot"), payload: z.object({}).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("room:remove-bot"), payload: z.object({ seatId: z.union(seatIds.map((seat) => z.literal(seat))) }).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("room:fill-bots"), payload: z.object({}).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("room:start"), payload: z.object({}).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("room:leave"), payload: z.object({}).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:attack"), payload: z.object({ cardId }).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:pass-attack"), payload: z.object({}).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:defend"), payload: z.object({ attackId, cardId }).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:take"), payload: z.object({}).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:stop-attack"), payload: z.object({}).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:assist-propose"), payload: z.object({ cardId }).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:assist-decide"), payload: z.object({ proposalId: z.string().min(1).max(64), accepted: z.boolean() }).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:exchange-trump-two"), payload: z.object({}).strict() }).strict(),
  z.object({ ...gameBase, type: z.literal("game:decline-trump-two"), payload: z.object({}).strict() }).strict(),
  z.object({ ...commandBase, type: z.literal("match:play-again"), payload: z.object({}).strict() }).strict()
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type GameCommandType = Extract<ClientCommand["type"], `game:${string}`>;

export const commandErrorCodes = [
  "BAD_REQUEST",
  "NOT_IN_ROOM",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "NICKNAME_TAKEN",
  "NOT_HOST",
  "NOT_READY",
  "GAME_ALREADY_STARTED",
  "STALE_REVISION",
  "DUPLICATE_REQUEST",
  "NOT_YOUR_TURN",
  "ILLEGAL_ACTION",
  "SESSION_REPLACED",
  "SERVER_RESTARTED",
  "RATE_LIMITED"
] as const;

export type CommandErrorCode = (typeof commandErrorCodes)[number];

export interface CommandAck {
  requestId: string;
  ok: boolean;
  revision?: number;
  error?: { code: CommandErrorCode; message: string };
}
