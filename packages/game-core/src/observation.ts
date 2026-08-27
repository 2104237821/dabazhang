import { SEATS, type Card, type CardId, type SeatId, type Suit, type TeamId } from "./cards.js";
import type { AssistProposal, AttackPair, GameState, MainTwoDecisionContext } from "./model.js";

export interface ObservedPlayer {
  readonly seatId: SeatId;
  readonly teamId: TeamId;
  readonly handCount: number;
  readonly hand?: Card[];
  readonly finishedPlace?: number;
}

export interface ObservedCardPlay {
  readonly card: Card;
  readonly player: SeatId;
}

export interface ObservedAttackPair {
  readonly attackId: string;
  readonly attack: ObservedCardPlay;
  readonly defense?: ObservedCardPlay;
}

export type ObservedPhase =
  | { readonly type: "dealing"; readonly nextSeat: SeatId; readonly round: number }
  | { readonly type: "await-opening-attack" }
  | { readonly type: "await-defense"; readonly attackId: string }
  | { readonly type: "await-continuation" }
  | { readonly type: "await-assist-approval"; readonly proposal?: AssistProposal }
  | {
      readonly type: "await-main-two-decision";
      readonly player: SeatId;
      readonly context: MainTwoDecisionContext;
    }
  | { readonly type: "post-round-refill"; readonly nextSeat: SeatId }
  | { readonly type: "finished" };

export interface PlayerObservation {
  readonly revision: number;
  readonly handNumber: number;
  readonly selfSeat: SeatId;
  readonly trumpSuit: Suit;
  readonly bottomCard?: Card;
  readonly drawPileCount: number;
  readonly players: ObservedPlayer[];
  readonly table: ObservedAttackPair[];
  readonly discardPile: Card[];
  readonly phase: ObservedPhase;
  readonly primaryAttacker: SeatId;
  readonly defender: SeatId;
  readonly mainTwoSwapAvailable: boolean;
  readonly finishedOrder: SeatId[];
  readonly winner?: TeamId;
}

function requireCard(state: GameState, cardId: CardId): Card {
  const card = state.cardsById[cardId];
  if (card === undefined) throw new Error(`Game state references unknown card: ${cardId}`);
  return card;
}

function observePair(state: GameState, pair: AttackPair): ObservedAttackPair {
  const attack = {
    card: requireCard(state, pair.attack.cardId),
    player: pair.attack.player
  };
  if (pair.defense === undefined) return { attackId: pair.attackId, attack };

  return {
    attackId: pair.attackId,
    attack,
    defense: {
      card: requireCard(state, pair.defense.cardId),
      player: pair.defense.player
    }
  };
}

function observePhase(state: GameState, selfSeat: SeatId): ObservedPhase {
  if (state.phase.type !== "await-assist-approval") return state.phase;
  if (selfSeat === state.primaryAttacker) return state.phase;
  return { type: "await-assist-approval" };
}

export function observeGame(state: GameState, selfSeat: SeatId): PlayerObservation {
  const players = SEATS.map((seat): ObservedPlayer => {
    const player = state.players[seat];
    const shared = {
      seatId: player.seatId,
      teamId: player.teamId,
      handCount: player.hand.length
    };
    const withHand = seat === selfSeat ? { hand: player.hand.map((id) => requireCard(state, id)) } : {};
    const withPlace = player.finishedPlace === undefined ? {} : { finishedPlace: player.finishedPlace };
    return { ...shared, ...withHand, ...withPlace };
  });

  const bottomCard =
    state.visibleBottomCardId === undefined ? {} : { bottomCard: requireCard(state, state.visibleBottomCardId) };
  const winner = state.winner === undefined ? {} : { winner: state.winner };

  return {
    revision: state.revision,
    handNumber: state.handNumber,
    selfSeat,
    trumpSuit: state.trumpSuit,
    ...bottomCard,
    drawPileCount: state.drawPile.length,
    players,
    table: state.table.map((pair) => observePair(state, pair)),
    discardPile: state.discardPile.map((id) => requireCard(state, id)),
    phase: observePhase(state, selfSeat),
    primaryAttacker: state.primaryAttacker,
    defender: state.defender,
    mainTwoSwapAvailable: state.mainTwoSwap.enabled && !state.mainTwoSwap.used && state.drawPile.length > 0,
    finishedOrder: [...state.finishedOrder],
    ...winner
  };
}
