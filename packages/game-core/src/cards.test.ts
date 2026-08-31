import { describe, expect, it } from "vitest";

import {
  compareStandardRanks,
  createDeck,
  isJoker,
  isTrump,
  isTrumpTwo,
  nextSeatCounterClockwise,
  teamForSeat
} from "./cards.js";

describe("card model", () => {
  it("creates 54 cards with stable unique ids", () => {
    const deck = createDeck();

    expect(deck).toHaveLength(54);
    expect(new Set(deck.map((card) => card.id))).toHaveLength(54);
    expect(deck.filter(isJoker)).toHaveLength(2);
  });

  it("recognizes trump cards and the trump two", () => {
    const deck = createDeck();
    const heartTwo = deck.find((card) => card.id === "heart-2");
    const heartAce = deck.find((card) => card.id === "heart-14");
    const spadeTwo = deck.find((card) => card.id === "spade-2");

    expect(heartTwo).toBeDefined();
    expect(heartAce).toBeDefined();
    expect(spadeTwo).toBeDefined();
    expect(isTrumpTwo(heartTwo!, "heart")).toBe(true);
    expect(isTrump(heartAce!, "heart")).toBe(true);
    expect(isTrumpTwo(spadeTwo!, "heart")).toBe(false);
  });

  it("orders standard ranks and seats consistently", () => {
    expect(compareStandardRanks(14, 13)).toBe(1);
    expect(compareStandardRanks(2, 3)).toBe(-1);
    expect(compareStandardRanks(10, 10)).toBe(0);
    expect(nextSeatCounterClockwise(3)).toBe(0);
    expect(nextSeatCounterClockwise(0, -1)).toBe(3);
    expect(teamForSeat(0)).toBe(teamForSeat(2));
    expect(teamForSeat(1)).toBe(teamForSeat(3));
  });
});
