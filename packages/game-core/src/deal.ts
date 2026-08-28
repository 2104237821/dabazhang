import {
  SEATS,
  createCardRegistry,
  createDeck,
  isJoker,
  nextSeatCounterClockwise,
  teamForSeat,
  type Card,
  type CardId,
  type SeatId
} from "./cards.js";
import type { GameState, PlayerState } from "./model.js";
import { randomSeat, shuffled, type RandomSource } from "./random.js";

const INITIAL_HAND_SIZE = 8;

export interface DealResult {
  readonly hands: Record<SeatId, CardId[]>;
  readonly drawPile: CardId[];
}

export interface CreateInitialGameOptions {
  readonly rng: RandomSource;
  readonly handNumber?: number;
  readonly dealStartSeat?: SeatId;
  readonly firstAttacker?: SeatId;
  readonly previousHandFirstFinisher?: SeatId;
}

function emptyHands(): Record<SeatId, CardId[]> {
  return { 0: [], 1: [], 2: [], 3: [] };
}

function createPlayers(hands: Record<SeatId, CardId[]>): Record<SeatId, PlayerState> {
  return {
    0: { seatId: 0, teamId: teamForSeat(0), hand: hands[0] },
    1: { seatId: 1, teamId: teamForSeat(1), hand: hands[1] },
    2: { seatId: 2, teamId: teamForSeat(2), hand: hands[2] },
    3: { seatId: 3, teamId: teamForSeat(3), hand: hands[3] }
  };
}

export function placeRandomNonJokerAtBottom(cards: readonly Card[], rng: RandomSource): Card[] {
  const shuffledCards = shuffled(cards, rng);
  const indicatorIndex = shuffledCards.findIndex((card) => !isJoker(card));
  if (indicatorIndex < 0) throw new Error("A deck must contain at least one non-joker card");

  const indicator = shuffledCards[indicatorIndex];
  if (indicator === undefined) throw new Error("Indicator index escaped the shuffled deck");
  shuffledCards.splice(indicatorIndex, 1);
  shuffledCards.push(indicator);
  return shuffledCards;
}

export function dealEightRounds(cardIds: readonly CardId[], startingSeat: SeatId): DealResult {
  const requiredCards = INITIAL_HAND_SIZE * SEATS.length;
  if (cardIds.length < requiredCards) {
    throw new RangeError(`Initial deal requires at least ${requiredCards} cards`);
  }

  const drawPile = [...cardIds];
  const hands = emptyHands();

  for (let round = 0; round < INITIAL_HAND_SIZE; round += 1) {
    for (let offset = 0; offset < SEATS.length; offset += 1) {
      const seat = nextSeatCounterClockwise(startingSeat, offset);
      const cardId = drawPile.shift();
      if (cardId === undefined) throw new Error("Draw pile unexpectedly ran out during initial deal");
      hands[seat].push(cardId);
    }
  }

  return { hands, drawPile };
}

export function createInitialGame(options: CreateInitialGameOptions): GameState {
  const preparedDeck = placeRandomNonJokerAtBottom(createDeck(), options.rng);
  const indicator = preparedDeck.at(-1);
  if (indicator === undefined || isJoker(indicator)) {
    throw new Error("Prepared deck must end with a suited indicator card");
  }

  const dealStartSeat = options.dealStartSeat ?? randomSeat(options.rng);
  const firstAttacker = options.firstAttacker ?? options.previousHandFirstFinisher ?? randomSeat(options.rng);
  const dealt = dealEightRounds(
    preparedDeck.map((card) => card.id),
    dealStartSeat
  );
  const cardsById = createCardRegistry(preparedDeck);
  const defender = nextSeatCounterClockwise(firstAttacker);
  const mainTwoCardId = `${indicator.suit}-2`;
  const mainTwoOwner = SEATS.find((seat) => dealt.hands[seat].includes(mainTwoCardId));
  const swapEnabled = indicator.rank !== 2;

  return {
    revision: 0,
    actionSequence: 0,
    handNumber: options.handNumber ?? 1,
    roundNumber: 1,
    cardsById,
    players: createPlayers(dealt.hands),
    trumpSuit: indicator.suit,
    originalIndicatorCardId: indicator.id,
    visibleBottomCardId: indicator.id,
    drawPile: dealt.drawPile,
    table: [],
    discardPile: [],
    phase:
      swapEnabled && mainTwoOwner !== undefined
        ? {
            type: "await-main-two-decision",
            player: mainTwoOwner,
            context: "deal",
            resume: { type: "opening-attack" }
          }
        : { type: "await-opening-attack" },
    dealStartSeat,
    primaryAttacker: firstAttacker,
    defender,
    mainTwoSwap: {
      enabled: swapEnabled,
      used: false,
      currentBottomCardId: indicator.id
    },
    finishedOrder: [],
    emptiedAtActionSequence: {}
  };
}

export function createNextHand(previousState: GameState, rng: RandomSource): GameState {
  const previousHandFirstFinisher = previousState.finishedOrder[0];
  if (previousHandFirstFinisher === undefined || previousState.phase.type !== "finished") {
    throw new Error("A next hand requires a finished previous hand with a first finisher");
  }
  return createInitialGame({
    rng,
    handNumber: previousState.handNumber + 1,
    previousHandFirstFinisher
  });
}
