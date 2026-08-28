import {
  isJoker,
  isTrump,
  type Card,
  type GameCommand,
  type LegalAction,
  type PlayerView
} from "@dabazhang/game-core";

export interface BotDecision {
  readonly command: GameCommand;
  readonly reason: string;
}

function selfHand(view: PlayerView): readonly Card[] {
  return view.players.find((player) => player.seatId === view.selfSeat)?.hand ?? [];
}

function scoreCard(card: Card, view: PlayerView): number {
  if (isJoker(card)) return card.rank === "smallJoker" ? 300 : 301;
  return card.rank + (isTrump(card, view.trumpSuit) ? 100 : 0);
}

function lowestCardId(view: PlayerView, cardIds: readonly string[]): string | undefined {
  const byId = new Map(selfHand(view).map((card) => [card.id, card]));
  return [...cardIds]
    .map((id) => byId.get(id))
    .filter((card): card is Card => card !== undefined)
    .sort((left, right) => scoreCard(left, view) - scoreCard(right, view))[0]?.id;
}

function actionOf<T extends LegalAction["type"]>(
  actions: readonly LegalAction[],
  type: T
): Extract<LegalAction, { type: T }> | undefined {
  return actions.find((action): action is Extract<LegalAction, { type: T }> => action.type === type);
}

export function shouldExchangeTrumpTwo(view: PlayerView): boolean {
  const bottom = view.bottomCard;
  if (bottom === undefined || isJoker(bottom)) return false;
  return bottom.suit === view.trumpSuit && bottom.rank > 2;
}

export function chooseBotDecision(view: PlayerView): BotDecision | undefined {
  const actions = view.legalActions;
  const base = { actor: view.selfSeat, expectedRevision: view.revision } as const;

  const exchange = actionOf(actions, "exchange-trump-two");
  if (exchange !== undefined && shouldExchangeTrumpTwo(view)) {
    return { command: { ...base, type: "exchange-trump-two" }, reason: "公开底牌是更大的主牌，执行主2换底" };
  }

  if (view.phase.type === "await-main-two-decision") {
    const decline = actionOf(actions, "decline-trump-two");
    if (decline !== undefined) {
      return { command: { ...base, type: "decline-trump-two" }, reason: "保留当前主2" };
    }
  }

  const defense = actionOf(actions, "play-defense");
  if (defense !== undefined) {
    const cardId = lowestCardId(view, defense.cardIds);
    if (cardId !== undefined) {
      return {
        command: { ...base, type: "play-defense", attackId: defense.attackId, cardId },
        reason: "使用代价最低的合法防守牌"
      };
    }
  }

  if (actionOf(actions, "collect-table") !== undefined) {
    return { command: { ...base, type: "collect-table" }, reason: "没有合适的防守牌，收取桌面牌" };
  }

  const assistDecision = actionOf(actions, "decide-assist");
  if (assistDecision !== undefined) {
    return {
      command: { ...base, type: "decide-assist", proposalId: assistDecision.proposalId, accepted: true },
      reason: "批准队友的合法协攻"
    };
  }

  const attack = actionOf(actions, "play-attack");
  if (attack !== undefined) {
    const cardId = lowestCardId(view, attack.cardIds);
    if (cardId !== undefined) {
      return { command: { ...base, type: "play-attack", cardId }, reason: "优先打出较小的非主牌并保留大牌" };
    }
  }

  const assist = actionOf(actions, "request-assist");
  if (assist !== undefined) {
    const cardId = lowestCardId(view, assist.cardIds);
    if (cardId !== undefined) {
      return { command: { ...base, type: "request-assist", cardId }, reason: "用代价最低的匹配牌帮助队友进攻" };
    }
  }

  if (actionOf(actions, "pass-attack") !== undefined) {
    return { command: { ...base, type: "pass-attack" }, reason: "手中只剩大小王，跳过主动进攻" };
  }

  if (actionOf(actions, "stop-attack") !== undefined) {
    return { command: { ...base, type: "stop-attack" }, reason: "没有合适的追加牌，结束进攻" };
  }

  const decline = actionOf(actions, "decline-trump-two");
  if (decline !== undefined) {
    return { command: { ...base, type: "decline-trump-two" }, reason: "当前不执行主2换底" };
  }

  return undefined;
}

export function chooseBotCommand(view: PlayerView): GameCommand | undefined {
  return chooseBotDecision(view)?.command;
}
