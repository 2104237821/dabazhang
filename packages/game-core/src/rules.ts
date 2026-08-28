import {
  SEATS,
  isJoker,
  isSuitedCard,
  isTrump,
  isTrumpTwo,
  nextSeatCounterClockwise,
  teamForSeat,
  type Card,
  type CardId,
  type SeatId,
  type StandardRank,
  type TeamId
} from "./cards.js";
import type {
  AppliedCommand,
  AttackPair,
  GameCommand,
  GameEvent,
  GameState,
  LegalAction,
  MainTwoResume,
  RefillProgress,
  Result,
  RoundOutcome,
  RuleError,
  RuleErrorCode
} from "./model.js";
import { observeGame, type PlayerObservation } from "./observation.js";

class RuleFault extends Error {
  readonly code: RuleErrorCode;

  constructor(code: RuleErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function reject(code: RuleErrorCode, message: string): never {
  throw new RuleFault(code, message);
}

function cardById(state: GameState, cardId: CardId): Card {
  const card = state.cardsById[cardId];
  if (card === undefined) reject("invalid-state", `Unknown card id: ${cardId}`);
  return card;
}

function playerHasCard(state: GameState, seat: SeatId, cardId: CardId): boolean {
  return state.players[seat].hand.includes(cardId);
}

function removeCardFromHand(state: GameState, seat: SeatId, cardId: CardId): void {
  const hand = state.players[seat].hand;
  const index = hand.indexOf(cardId);
  if (index < 0) reject("card-not-in-hand", `Seat ${seat} does not hold ${cardId}`);
  hand.splice(index, 1);
  if (hand.length === 0) state.emptiedAtActionSequence[seat] = state.actionSequence;
}

function addCardsToHand(state: GameState, seat: SeatId, cardIds: readonly CardId[]): void {
  if (cardIds.length === 0) return;
  state.players[seat].hand.push(...cardIds);
  delete state.emptiedAtActionSequence[seat];
}

function currentAttackPair(state: GameState): AttackPair {
  const pair = state.table.at(-1);
  if (pair === undefined || pair.defense !== undefined) {
    reject("invalid-state", "Defense phase requires one unresolved attack");
  }
  return pair;
}

function allTableCardIds(state: GameState): CardId[] {
  return state.table.flatMap((pair) =>
    pair.defense === undefined ? [pair.attack.cardId] : [pair.attack.cardId, pair.defense.cardId]
  );
}

function nextActiveSeat(state: GameState, seat: SeatId, inclusive = false): SeatId {
  for (let step = inclusive ? 0 : 1; step <= SEATS.length; step += 1) {
    const candidate = nextSeatCounterClockwise(seat, step);
    if (state.players[candidate].finishedPlace === undefined) return candidate;
  }
  reject("invalid-state", "No active player remains");
}

function regularRank(card: Card): StandardRank | undefined {
  return isSuitedCard(card) ? card.rank : undefined;
}

function tableRanks(state: GameState): Set<StandardRank> {
  const ranks = new Set<StandardRank>();
  for (const cardId of allTableCardIds(state)) {
    const rank = regularRank(cardById(state, cardId));
    if (rank !== undefined) ranks.add(rank);
  }
  return ranks;
}

export function getLegalDefenseCardIds(state: GameState): CardId[] {
  if (state.phase.type !== "await-defense") return [];
  const attackCard = cardById(state, currentAttackPair(state).attack.cardId);
  if (!isSuitedCard(attackCard)) reject("invalid-state", "A joker cannot be an attack card");

  const handCards = state.players[state.defender].hand.map((id) => cardById(state, id));
  const jokers = handCards.filter(isJoker).map((card) => card.id);

  if (isTrump(attackCard, state.trumpSuit)) {
    const higherTrumps = handCards
      .filter(
        (card) =>
          isSuitedCard(card) &&
          card.suit === state.trumpSuit &&
          card.rank > attackCard.rank
      )
      .map((card) => card.id);
    return [...higherTrumps, ...jokers];
  }

  const higherFollowingSuit = handCards
    .filter(
      (card) =>
        isSuitedCard(card) &&
        card.suit === attackCard.suit &&
        card.rank > attackCard.rank
    )
    .map((card) => card.id);

  if (higherFollowingSuit.length > 0) return [...higherFollowingSuit, ...jokers];

  const trumps = handCards.filter((card) => isTrump(card, state.trumpSuit)).map((card) => card.id);
  return [...trumps, ...jokers];
}

function legalOpeningCardIds(state: GameState): CardId[] {
  return state.players[state.primaryAttacker].hand.filter((id) => !isJoker(cardById(state, id)));
}

function legalContinuationCardIds(state: GameState, seat: SeatId): CardId[] {
  const ranks = tableRanks(state);
  return state.players[seat].hand.filter((id) => {
    const card = cardById(state, id);
    return isSuitedCard(card) && ranks.has(card.rank);
  });
}

function mainTwoCardId(state: GameState, seat: SeatId): CardId | undefined {
  return state.players[seat].hand.find((id) => isTrumpTwo(cardById(state, id), state.trumpSuit));
}

function baseCanExchangeMainTwo(state: GameState, seat: SeatId): boolean {
  if (!state.mainTwoSwap.enabled || state.mainTwoSwap.used || state.drawPile.length === 0) return false;
  if (mainTwoCardId(state, seat) === undefined) return false;
  const bottom = state.drawPile.at(-1);
  return bottom !== undefined && bottom === state.mainTwoSwap.currentBottomCardId;
}

function canExchangeMainTwoNow(state: GameState, seat: SeatId): boolean {
  if (!baseCanExchangeMainTwo(state, seat)) return false;
  switch (state.phase.type) {
    case "await-opening-attack":
    case "await-continuation":
    case "await-assist-approval":
      return seat === state.primaryAttacker;
    case "await-defense":
      return seat === state.defender;
    case "await-main-two-decision":
      return seat === state.phase.player;
    default:
      return false;
  }
}

function activeTeammate(state: GameState, seat: SeatId): SeatId | undefined {
  return SEATS.find(
    (candidate) =>
      candidate !== seat &&
      teamForSeat(candidate) === teamForSeat(seat) &&
      state.players[candidate].finishedPlace === undefined
  );
}

export function getLegalActions(state: GameState, seat: SeatId): LegalAction[] {
  if (state.phase.type === "finished") return [];
  const actions: LegalAction[] = [];

  if (state.phase.type === "await-main-two-decision") {
    if (seat !== state.phase.player) return actions;
    if (canExchangeMainTwoNow(state, seat)) actions.push({ type: "exchange-trump-two" });
    actions.push({ type: "decline-trump-two" });
    return actions;
  }

  if (state.phase.type === "await-opening-attack" && seat === state.primaryAttacker) {
    const cardIds = legalOpeningCardIds(state);
    if (cardIds.length > 0) actions.push({ type: "play-attack", cardIds });
    if (
      cardIds.length === 0 &&
      state.drawPile.length === 0 &&
      state.players[seat].hand.length > 0 &&
      state.players[seat].hand.every((id) => isJoker(cardById(state, id)))
    ) {
      actions.push({ type: "pass-attack" });
    }
  }

  if (state.phase.type === "await-defense" && seat === state.defender) {
    const cardIds = getLegalDefenseCardIds(state);
    if (cardIds.length > 0) {
      actions.push({ type: "play-defense", attackId: state.phase.attackId, cardIds });
    }
    actions.push({ type: "collect-table" });
  }

  if (state.phase.type === "await-continuation") {
    if (seat === state.primaryAttacker) {
      const cardIds = legalContinuationCardIds(state, seat);
      if (cardIds.length > 0) actions.push({ type: "play-attack", cardIds });
      actions.push({ type: "stop-attack" });
    } else {
      const teammate = activeTeammate(state, state.primaryAttacker);
      if (
        teammate === seat &&
        teamForSeat(state.primaryAttacker) !== teamForSeat(state.defender)
      ) {
        const cardIds = legalContinuationCardIds(state, seat);
        if (cardIds.length > 0) actions.push({ type: "request-assist", cardIds });
      }
    }
  }

  if (state.phase.type === "await-assist-approval" && seat === state.primaryAttacker) {
    actions.push({
      type: "decide-assist",
      proposalId: state.phase.proposal.proposalId,
      choices: [true, false]
    });
  }

  if (canExchangeMainTwoNow(state, seat)) actions.push({ type: "exchange-trump-two" });
  return actions;
}

function makeRefillProgress(state: GameState, outcome: RoundOutcome): RefillProgress {
  return {
    outcome,
    roundAttacker: state.primaryAttacker,
    roundDefender: state.defender,
    nextSeat: state.primaryAttacker,
    seatsRemaining: SEATS.length,
    promptedSeats: []
  };
}

function disableSwapWhenUnavailable(state: GameState): void {
  if (state.drawPile.length > 0) return;
  state.mainTwoSwap.enabled = false;
  delete state.mainTwoSwap.currentBottomCardId;
  delete state.visibleBottomCardId;
}

function teamCompletionIndex(state: GameState, team: TeamId): number | undefined {
  const places = SEATS.filter((seat) => teamForSeat(seat) === team).map((seat) => state.finishedOrder.indexOf(seat));
  if (places.some((place) => place < 0)) return undefined;
  return Math.max(...places);
}

function finishEligiblePlayers(state: GameState, events: GameEvent[]): void {
  if (state.drawPile.length > 0) return;
  const newlyFinished = SEATS.filter(
    (seat) => state.players[seat].finishedPlace === undefined && state.players[seat].hand.length === 0
  ).sort((left, right) => {
    const leftSequence = state.emptiedAtActionSequence[left] ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = state.emptiedAtActionSequence[right] ?? Number.MAX_SAFE_INTEGER;
    return leftSequence - rightSequence || left - right;
  });

  for (const seat of newlyFinished) {
    const place = state.finishedOrder.length + 1;
    state.finishedOrder.push(seat);
    state.players[seat].finishedPlace = place;
    events.push({ type: "player-finished", player: seat, place });
  }

  const teamZeroCompletion = teamCompletionIndex(state, 0);
  const teamOneCompletion = teamCompletionIndex(state, 1);
  let winner: TeamId | undefined;
  if (teamZeroCompletion !== undefined && teamOneCompletion !== undefined) {
    winner = teamZeroCompletion < teamOneCompletion ? 0 : 1;
  } else if (teamZeroCompletion !== undefined) {
    winner = 0;
  } else if (teamOneCompletion !== undefined) {
    winner = 1;
  }

  if (winner !== undefined) {
    state.winner = winner;
    state.phase = { type: "finished" };
    events.push({ type: "team-won", team: winner });
  }
}

function advanceToNextRound(state: GameState, progress: RefillProgress, events: GameEvent[]): void {
  finishEligiblePlayers(state, events);
  if (state.phase.type === "finished") return;

  const nextAttacker =
    progress.outcome === "defense-succeeded"
      ? nextActiveSeat(state, progress.roundDefender, true)
      : nextActiveSeat(state, progress.roundDefender);
  const nextDefender = nextActiveSeat(state, nextAttacker);
  state.primaryAttacker = nextAttacker;
  state.defender = nextDefender;
  state.roundNumber += 1;
  state.phase = { type: "await-opening-attack" };
  events.push({ type: "turn-advanced", primaryAttacker: nextAttacker, defender: nextDefender });
}

function resumeAfterMainTwoDecision(state: GameState, resume: MainTwoResume, events: GameEvent[]): void {
  if (resume.type === "opening-attack") {
    state.phase = { type: "await-opening-attack" };
    return;
  }
  advanceRefill(state, resume.progress, events);
}

function nextRefillProgress(progress: RefillProgress): RefillProgress {
  return {
    ...progress,
    nextSeat: nextSeatCounterClockwise(progress.nextSeat),
    seatsRemaining: progress.seatsRemaining - 1
  };
}

function promptForMainTwo(
  state: GameState,
  progress: RefillProgress,
  seat: SeatId,
  context: "draw" | "post-collect"
): void {
  const promptedSeats = progress.promptedSeats.includes(seat)
    ? progress.promptedSeats
    : [...progress.promptedSeats, seat];
  state.phase = {
    type: "await-main-two-decision",
    player: seat,
    context,
    resume: { type: "refill", progress: { ...progress, promptedSeats } }
  };
}

function advanceRefill(state: GameState, initialProgress: RefillProgress, events: GameEvent[]): void {
  let progress = initialProgress;
  state.phase = { type: "post-round-refill", progress };

  while (progress.seatsRemaining > 0 && state.drawPile.length > 0) {
    const seat = progress.nextSeat;
    const player = state.players[seat];
    if (player.finishedPlace !== undefined || player.hand.length >= 8) {
      progress = nextRefillProgress(progress);
      state.phase = { type: "post-round-refill", progress };
      continue;
    }

    if (baseCanExchangeMainTwo(state, seat) && !progress.promptedSeats.includes(seat)) {
      promptForMainTwo(state, progress, seat, "draw");
      return;
    }

    const drawnCards: CardId[] = [];
    while (player.hand.length < 8 && state.drawPile.length > 0) {
      const cardId = state.drawPile.shift();
      if (cardId === undefined) reject("invalid-state", "Draw pile unexpectedly ran out");
      addCardsToHand(state, seat, [cardId]);
      drawnCards.push(cardId);
      disableSwapWhenUnavailable(state);

      if (baseCanExchangeMainTwo(state, seat) && !progress.promptedSeats.includes(seat)) {
        events.push({ type: "cards-refilled", player: seat, cardIds: drawnCards });
        promptForMainTwo(state, progress, seat, "draw");
        return;
      }
    }

    if (drawnCards.length > 0) events.push({ type: "cards-refilled", player: seat, cardIds: drawnCards });
    progress = nextRefillProgress(progress);
    state.phase = { type: "post-round-refill", progress };
  }

  disableSwapWhenUnavailable(state);
  advanceToNextRound(state, progress, events);
}

function settleSuccessfulDefense(state: GameState, events: GameEvent[]): void {
  const cardIds = allTableCardIds(state);
  state.discardPile.push(...cardIds);
  state.table = [];
  events.push({ type: "table-discarded", cardIds });

  if (cardIds.some((id) => isTrumpTwo(cardById(state, id), state.trumpSuit))) {
    state.mainTwoSwap.enabled = false;
  }
  advanceRefill(state, makeRefillProgress(state, "defense-succeeded"), events);
}

function settleFailedDefense(state: GameState, events: GameEvent[]): void {
  const cardIds = allTableCardIds(state);
  addCardsToHand(state, state.defender, cardIds);
  state.table = [];
  events.push({ type: "defender-collected", player: state.defender, cardIds });

  const progress = makeRefillProgress(state, "defense-failed");
  if (baseCanExchangeMainTwo(state, state.defender)) {
    promptForMainTwo(state, progress, state.defender, "post-collect");
    return;
  }
  advanceRefill(state, progress, events);
}

function exchangeMainTwo(state: GameState, actor: SeatId, events: GameEvent[]): void {
  if (!canExchangeMainTwoNow(state, actor)) reject("main-two-unavailable", "Trump two cannot be exchanged now");
  const trumpTwoId = mainTwoCardId(state, actor);
  const receivedCardId = state.drawPile.pop();
  if (trumpTwoId === undefined || receivedCardId === undefined) {
    reject("invalid-state", "Trump two exchange is missing a required card");
  }

  removeCardFromHand(state, actor, trumpTwoId);
  addCardsToHand(state, actor, [receivedCardId]);
  state.drawPile.push(trumpTwoId);
  state.mainTwoSwap.used = true;
  state.mainTwoSwap.enabled = false;
  state.mainTwoSwap.currentBottomCardId = trumpTwoId;
  state.visibleBottomCardId = trumpTwoId;
  events.push({
    type: "main-two-exchanged",
    player: actor,
    returnedCardId: trumpTwoId,
    receivedCardId
  });
}

function playAttack(state: GameState, actor: SeatId, cardId: CardId, events: GameEvent[]): void {
  const opening = state.phase.type === "await-opening-attack";
  const continuation = state.phase.type === "await-continuation";
  if (!opening && !continuation) reject("wrong-phase", "The game is not accepting an attack card");
  if (actor !== state.primaryAttacker) reject("not-your-turn", "Only the primary attacker may play directly");
  if (!playerHasCard(state, actor, cardId)) reject("card-not-in-hand", `Seat ${actor} does not hold ${cardId}`);
  const legal = opening ? legalOpeningCardIds(state) : legalContinuationCardIds(state, actor);
  if (!legal.includes(cardId)) reject("illegal-card", "This card is not a legal attack");

  removeCardFromHand(state, actor, cardId);
  const attackId = `attack-${state.actionSequence}`;
  state.table.push({
    attackId,
    attack: { cardId, player: actor, actionSequence: state.actionSequence }
  });
  state.phase = { type: "await-defense", attackId };
  events.push({ type: "attack-played", attackId, player: actor, cardId, source: opening ? "opening" : "continuation" });
}

function passAttack(state: GameState, actor: SeatId, events: GameEvent[]): void {
  if (state.phase.type !== "await-opening-attack") {
    reject("wrong-phase", "An opening attack cannot be passed now");
  }
  if (actor !== state.primaryAttacker) {
    reject("not-your-turn", "Only the primary attacker may pass");
  }
  const hand = state.players[actor].hand;
  if (
    state.drawPile.length > 0 ||
    hand.length === 0 ||
    hand.some((id) => !isJoker(cardById(state, id)))
  ) {
    reject("illegal-card", "Attack may be passed only when the draw pile is empty and every card is a joker");
  }

  events.push({ type: "attack-passed", player: actor });
  const attackersWithSuitedCards = SEATS.filter(
    (seat) =>
      state.players[seat].finishedPlace === undefined &&
      state.players[seat].hand.some((id) => !isJoker(cardById(state, id)))
  );

  if (attackersWithSuitedCards.length > 0) {
    let nextAttacker: SeatId | undefined;
    for (let step = 1; step <= SEATS.length; step += 1) {
      const candidate = nextSeatCounterClockwise(actor, step);
      if (attackersWithSuitedCards.includes(candidate)) {
        nextAttacker = candidate;
        break;
      }
    }
    if (nextAttacker === undefined) reject("invalid-state", "A legal next attacker could not be found");
    const nextDefender = nextActiveSeat(state, nextAttacker);
    state.primaryAttacker = nextAttacker;
    state.defender = nextDefender;
    state.roundNumber += 1;
    state.phase = { type: "await-opening-attack" };
    events.push({ type: "turn-advanced", primaryAttacker: nextAttacker, defender: nextDefender });
    return;
  }

  let retirementOrder = 0;
  for (let step = 0; step < SEATS.length; step += 1) {
    const seat = nextSeatCounterClockwise(actor, step);
    const player = state.players[seat];
    if (player.finishedPlace !== undefined || player.hand.length === 0) continue;
    if (player.hand.some((id) => !isJoker(cardById(state, id)))) {
      reject("invalid-state", "Automatic joker retirement encountered a suited card");
    }
    const cardIds = [...player.hand];
    player.hand = [];
    state.discardPile.push(...cardIds);
    state.emptiedAtActionSequence[seat] = state.actionSequence + retirementOrder / 10;
    retirementOrder += 1;
    events.push({ type: "jokers-retired", player: seat, cardIds });
  }
  finishEligiblePlayers(state, events);
  if (state.winner === undefined) {
    reject("invalid-state", "Retiring every remaining joker must finish the hand");
  }
}

function playDefense(
  state: GameState,
  actor: SeatId,
  attackId: string,
  cardId: CardId,
  events: GameEvent[]
): void {
  if (state.phase.type !== "await-defense") reject("wrong-phase", "The game is not waiting for defense");
  if (actor !== state.defender) reject("not-your-turn", "Only the defender may defend");
  if (state.phase.attackId !== attackId) reject("illegal-defense", "Defense targets the wrong attack");
  if (!playerHasCard(state, actor, cardId)) reject("card-not-in-hand", `Seat ${actor} does not hold ${cardId}`);
  if (!getLegalDefenseCardIds(state).includes(cardId)) reject("illegal-defense", "This card cannot beat the attack");

  removeCardFromHand(state, actor, cardId);
  currentAttackPair(state).defense = { cardId, player: actor, actionSequence: state.actionSequence };
  events.push({ type: "defense-played", attackId, player: actor, cardId });

  if (state.players[actor].hand.length === 0) {
    settleSuccessfulDefense(state, events);
  } else {
    state.phase = { type: "await-continuation" };
  }
}

function requestAssist(state: GameState, actor: SeatId, cardId: CardId, events: GameEvent[]): void {
  if (state.phase.type !== "await-continuation") reject("wrong-phase", "Assistance is not available now");
  const teammate = activeTeammate(state, state.primaryAttacker);
  if (
    teammate !== actor ||
    teamForSeat(state.primaryAttacker) === teamForSeat(state.defender)
  ) {
    reject("illegal-assist", "This player cannot assist the current attack");
  }
  if (!playerHasCard(state, actor, cardId)) reject("card-not-in-hand", `Seat ${actor} does not hold ${cardId}`);
  if (!legalContinuationCardIds(state, actor).includes(cardId)) {
    reject("illegal-assist", "The proposed card does not match a table rank");
  }

  const proposal = { proposalId: `proposal-${state.actionSequence}`, player: actor, cardId };
  state.phase = { type: "await-assist-approval", proposal };
  events.push({ type: "assist-requested", proposal });
}

function decideAssist(
  state: GameState,
  actor: SeatId,
  proposalId: string,
  accepted: boolean,
  events: GameEvent[]
): void {
  if (state.phase.type !== "await-assist-approval") reject("wrong-phase", "No assistance request is pending");
  if (actor !== state.primaryAttacker) reject("not-your-turn", "Only the primary attacker can decide assistance");
  if (proposalId !== state.phase.proposal.proposalId) reject("assist-not-found", "Assistance proposal does not match");
  const proposal = state.phase.proposal;
  events.push({ type: "assist-decided", proposalId, accepted });

  if (!accepted) {
    state.phase = { type: "await-continuation" };
    return;
  }

  if (!playerHasCard(state, proposal.player, proposal.cardId)) {
    reject("card-not-in-hand", "The proposed assistance card is no longer in hand");
  }
  if (!legalContinuationCardIds(state, proposal.player).includes(proposal.cardId)) {
    reject("illegal-assist", "The proposed assistance card is no longer legal");
  }

  removeCardFromHand(state, proposal.player, proposal.cardId);
  const attackId = `attack-${state.actionSequence}`;
  state.table.push({
    attackId,
    attack: { cardId: proposal.cardId, player: proposal.player, actionSequence: state.actionSequence }
  });
  state.phase = { type: "await-defense", attackId };
  events.push({
    type: "attack-played",
    attackId,
    player: proposal.player,
    cardId: proposal.cardId,
    source: "assist"
  });
}

function handleCommand(state: GameState, command: GameCommand, events: GameEvent[]): void {
  switch (command.type) {
    case "play-attack":
      playAttack(state, command.actor, command.cardId, events);
      return;
    case "pass-attack":
      passAttack(state, command.actor, events);
      return;
    case "play-defense":
      playDefense(state, command.actor, command.attackId, command.cardId, events);
      return;
    case "collect-table":
      if (state.phase.type !== "await-defense") reject("wrong-phase", "The game is not waiting for defense");
      if (command.actor !== state.defender) reject("not-your-turn", "Only the defender may collect the table");
      settleFailedDefense(state, events);
      return;
    case "stop-attack":
      if (state.phase.type !== "await-continuation") reject("wrong-phase", "The attack cannot stop now");
      if (command.actor !== state.primaryAttacker) reject("not-your-turn", "Only the primary attacker may stop");
      settleSuccessfulDefense(state, events);
      return;
    case "request-assist":
      requestAssist(state, command.actor, command.cardId, events);
      return;
    case "decide-assist":
      decideAssist(state, command.actor, command.proposalId, command.accepted, events);
      return;
    case "exchange-trump-two": {
      const resume = state.phase.type === "await-main-two-decision" ? state.phase.resume : undefined;
      exchangeMainTwo(state, command.actor, events);
      if (resume !== undefined) resumeAfterMainTwoDecision(state, resume, events);
      return;
    }
    case "decline-trump-two":
      if (state.phase.type !== "await-main-two-decision") reject("wrong-phase", "No trump two decision is pending");
      if (command.actor !== state.phase.player) reject("not-your-turn", "Only the prompted player may decline");
      resumeAfterMainTwoDecision(state, state.phase.resume, events);
      return;
  }
}

export function dispatch(state: GameState, command: GameCommand): Result<AppliedCommand> {
  if (command.expectedRevision !== state.revision) {
    return {
      ok: false,
      error: { code: "stale-revision", message: `Expected revision ${state.revision}` }
    };
  }
  if (state.phase.type === "finished") {
    return { ok: false, error: { code: "game-finished", message: "The hand has already finished" } };
  }

  const nextState = structuredClone(state);
  nextState.actionSequence += 1;
  const events: GameEvent[] = [];

  try {
    handleCommand(nextState, command, events);
    nextState.revision += 1;
    return { ok: true, value: { state: nextState, events } };
  } catch (error) {
    if (error instanceof RuleFault) {
      const ruleError: RuleError = { code: error.code, message: error.message };
      return { ok: false, error: ruleError };
    }
    throw error;
  }
}

export const applyAction = dispatch;

export interface PlayerView extends PlayerObservation {
  readonly legalActions: LegalAction[];
}

export function buildPlayerView(state: GameState, seat: SeatId): PlayerView {
  return { ...observeGame(state, seat), legalActions: getLegalActions(state, seat) };
}

export function replay(initialState: GameState, commands: readonly GameCommand[]): Result<AppliedCommand> {
  let state = structuredClone(initialState);
  const events: GameEvent[] = [];
  for (const command of commands) {
    const applied = dispatch(state, command);
    if (!applied.ok) return applied;
    state = applied.value.state;
    events.push(...applied.value.events);
  }
  return { ok: true, value: { state, events } };
}
