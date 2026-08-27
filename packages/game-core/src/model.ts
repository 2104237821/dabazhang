import type { Card, CardId, SeatId, Suit, TeamId } from "./cards.js";

export interface PlayerState {
  readonly seatId: SeatId;
  readonly teamId: TeamId;
  hand: CardId[];
  finishedPlace?: number;
}

export interface CardPlay {
  readonly cardId: CardId;
  readonly player: SeatId;
  readonly actionSequence: number;
}

export interface AttackPair {
  readonly attackId: string;
  readonly attack: CardPlay;
  defense?: CardPlay;
}

export interface AssistProposal {
  readonly proposalId: string;
  readonly player: SeatId;
  readonly cardId: CardId;
}

export type MainTwoDecisionContext = "deal" | "draw" | "attack" | "defense" | "post-collect";

export type Phase =
  | { readonly type: "dealing"; readonly nextSeat: SeatId; readonly round: number }
  | { readonly type: "await-opening-attack" }
  | { readonly type: "await-defense"; readonly attackId: string }
  | { readonly type: "await-continuation" }
  | { readonly type: "await-assist-approval"; readonly proposal: AssistProposal }
  | {
      readonly type: "await-main-two-decision";
      readonly player: SeatId;
      readonly context: MainTwoDecisionContext;
    }
  | { readonly type: "post-round-refill"; readonly nextSeat: SeatId }
  | { readonly type: "finished" };

export interface MainTwoSwapState {
  enabled: boolean;
  used: boolean;
  currentBottomCardId?: CardId;
}

export interface GameState {
  revision: number;
  actionSequence: number;
  handNumber: number;
  cardsById: Record<CardId, Card>;
  players: Record<SeatId, PlayerState>;
  trumpSuit: Suit;
  originalIndicatorCardId: CardId;
  visibleBottomCardId?: CardId;
  drawPile: CardId[];
  table: AttackPair[];
  discardPile: CardId[];
  phase: Phase;
  dealStartSeat: SeatId;
  primaryAttacker: SeatId;
  defender: SeatId;
  mainTwoSwap: MainTwoSwapState;
  finishedOrder: SeatId[];
  emptiedAtActionSequence: Partial<Record<SeatId, number>>;
  winner?: TeamId;
}

interface CommandBase {
  readonly actor: SeatId;
  readonly expectedRevision: number;
}

export type GameCommand =
  | (CommandBase & { readonly type: "play-attack"; readonly cardId: CardId })
  | (CommandBase & { readonly type: "play-defense"; readonly attackId: string; readonly cardId: CardId })
  | (CommandBase & { readonly type: "collect-table" })
  | (CommandBase & { readonly type: "stop-attack" })
  | (CommandBase & { readonly type: "request-assist"; readonly cardId: CardId })
  | (CommandBase & { readonly type: "decide-assist"; readonly proposalId: string; readonly accepted: boolean })
  | (CommandBase & { readonly type: "exchange-trump-two" })
  | (CommandBase & { readonly type: "decline-trump-two" });

export type GameEvent =
  | { readonly type: "hand-started"; readonly trumpSuit: Suit; readonly indicatorCardId: CardId; readonly firstAttacker: SeatId }
  | { readonly type: "card-dealt"; readonly player: SeatId; readonly cardId: CardId }
  | { readonly type: "attack-played"; readonly attackId: string; readonly player: SeatId; readonly cardId: CardId }
  | { readonly type: "defense-played"; readonly attackId: string; readonly player: SeatId; readonly cardId: CardId }
  | { readonly type: "assist-requested"; readonly proposal: AssistProposal }
  | { readonly type: "assist-decided"; readonly proposalId: string; readonly accepted: boolean }
  | { readonly type: "main-two-exchanged"; readonly player: SeatId; readonly receivedCardId: CardId }
  | { readonly type: "defender-collected"; readonly player: SeatId; readonly cardIds: CardId[] }
  | { readonly type: "table-discarded"; readonly cardIds: CardId[] }
  | { readonly type: "cards-refilled"; readonly player: SeatId; readonly cardIds: CardId[] }
  | { readonly type: "player-finished"; readonly player: SeatId; readonly place: number }
  | { readonly type: "turn-advanced"; readonly primaryAttacker: SeatId; readonly defender: SeatId }
  | { readonly type: "team-won"; readonly team: TeamId };

export const RULE_ERROR_CODES = [
  "stale-revision",
  "wrong-phase",
  "not-your-turn",
  "card-not-in-hand",
  "illegal-card",
  "illegal-defense",
  "illegal-assist",
  "assist-not-found",
  "main-two-unavailable",
  "game-finished",
  "invalid-state"
] as const;

export type RuleErrorCode = (typeof RULE_ERROR_CODES)[number];

export interface RuleError {
  readonly code: RuleErrorCode;
  readonly message: string;
}

export type Result<T, E = RuleError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface AppliedCommand {
  readonly state: GameState;
  readonly events: GameEvent[];
}
