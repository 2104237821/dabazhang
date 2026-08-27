import { SEATS, type SeatId } from "./cards.js";

export type RandomSource = () => number;

function nextRandom(rng: RandomSource): number {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError(`Random source must return a finite value in [0, 1); received ${value}`);
  }
  return value;
}

export function shuffled<T>(values: readonly T[], rng: RandomSource): T[] {
  const result = [...values];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom(rng) * (index + 1));
    const current = result[index];
    const replacement = result[swapIndex];
    if (current === undefined || replacement === undefined) {
      throw new Error("Shuffle index escaped the array bounds");
    }
    result[index] = replacement;
    result[swapIndex] = current;
  }

  return result;
}

export function randomSeat(rng: RandomSource): SeatId {
  const seat = SEATS[Math.floor(nextRandom(rng) * SEATS.length)];
  if (seat === undefined) throw new Error("Random seat index escaped the seat list");
  return seat;
}
