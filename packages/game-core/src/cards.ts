export const SUITS = ["spade", "heart", "club", "diamond"] as const;
export const STANDARD_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export const JOKER_RANKS = ["smallJoker", "bigJoker"] as const;
export const SEATS = [0, 1, 2, 3] as const;

export type Suit = (typeof SUITS)[number];
export type StandardRank = (typeof STANDARD_RANKS)[number];
export type JokerRank = (typeof JOKER_RANKS)[number];
export type Rank = StandardRank | JokerRank;
export type SeatId = (typeof SEATS)[number];
export type TeamId = 0 | 1;
export type CardId = string;

export interface SuitedCard {
  readonly id: CardId;
  readonly suit: Suit;
  readonly rank: StandardRank;
}

export interface JokerCard {
  readonly id: CardId;
  readonly suit: "joker";
  readonly rank: JokerRank;
}

export type Card = SuitedCard | JokerCard;

export function createDeck(): Card[] {
  const suitedCards = SUITS.flatMap((suit) =>
    STANDARD_RANKS.map(
      (rank): SuitedCard => ({
        id: `${suit}-${rank}`,
        suit,
        rank
      })
    )
  );

  return [
    ...suitedCards,
    { id: "joker-small", suit: "joker", rank: "smallJoker" },
    { id: "joker-big", suit: "joker", rank: "bigJoker" }
  ];
}

export function createCardRegistry(cards: readonly Card[]): Record<CardId, Card> {
  const registry: Record<CardId, Card> = {};

  for (const card of cards) {
    if (registry[card.id] !== undefined) {
      throw new Error(`Duplicate card id: ${card.id}`);
    }
    registry[card.id] = card;
  }

  return registry;
}

export function isJoker(card: Card): card is JokerCard {
  return card.suit === "joker";
}

export function isSuitedCard(card: Card): card is SuitedCard {
  return card.suit !== "joker";
}

export function isTrump(card: Card, trumpSuit: Suit): boolean {
  return isSuitedCard(card) && card.suit === trumpSuit;
}

export function isTrumpTwo(card: Card, trumpSuit: Suit): boolean {
  return isTrump(card, trumpSuit) && card.rank === 2;
}

export function hasSameRank(left: Card, right: Card): boolean {
  return left.rank === right.rank;
}

export function compareStandardRanks(left: StandardRank, right: StandardRank): -1 | 0 | 1 {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function teamForSeat(seat: SeatId): TeamId {
  return (seat % 2) as TeamId;
}

export function nextSeatCounterClockwise(seat: SeatId, steps = 1): SeatId {
  const normalizedSteps = ((steps % SEATS.length) + SEATS.length) % SEATS.length;
  return ((seat + normalizedSteps) % SEATS.length) as SeatId;
}
