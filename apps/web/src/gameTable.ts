import type { CardView, GamePhase, GameViewState, PlayerView, Rank, Suit } from "@dabazhang/protocol";

export type CardFocusKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";
export type DemoScenarioId = "active-round" | "late-game";

export const suitPresentation: Record<Suit, { label: string; symbol: string; color: "black" | "red" }> = {
  spade: { label: "黑桃", symbol: "♠", color: "black" },
  heart: { label: "红桃", symbol: "♥", color: "red" },
  club: { label: "梅花", symbol: "♣", color: "black" },
  diamond: { label: "方块", symbol: "♦", color: "red" }
};

export const phaseLabels: Record<GamePhase, string> = {
  "await-opening-attack": "等待首攻",
  "await-defense": "等待防守",
  "await-continuation": "等待追加",
  "await-assist-approval": "协攻待确认",
  "await-main-two-decision": "主2换底",
  "post-round-refill": "正在补牌",
  finished: "本局结束"
};

export function rankLabel(rank: Rank): string {
  if (rank === "smallJoker") return "小王";
  if (rank === "bigJoker") return "大王";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  if (rank === 14) return "A";
  return String(rank);
}

export function describeCard(card: CardView): string {
  if (card.suit === "joker") return rankLabel(card.rank);
  const description = `${suitPresentation[card.suit].label}${rankLabel(card.rank)}`;
  return card.isTrump ? `${description}，主牌` : description;
}

export function getSelectableCardIds(game: GameViewState): Set<string> {
  return new Set(game.legalActions.flatMap((action) => action.cardIds ?? []));
}

export function getNextCardFocusIndex(current: number, key: CardFocusKey, cardCount: number): number {
  if (cardCount <= 0) return 0;
  if (key === "Home") return 0;
  if (key === "End") return cardCount - 1;
  if (key === "ArrowRight") return (current + 1) % cardCount;
  return (current - 1 + cardCount) % cardCount;
}

export function playerStatusLabel(player: PlayerView): string {
  if (player.finishedPlace !== undefined) return `第 ${player.finishedPlace} 名出完`;
  if (!player.online && player.controller === "human-grace") return "离线 · 等待重连";
  if (player.controller === "bot-takeover") return "机器人接管";
  if (player.controller === "bot-fixed") return "机器人玩家";
  if (!player.online) return "离线";
  return `${player.handCount} 张牌`;
}

export function playerRoleLabel(game: GameViewState, player: PlayerView): string | null {
  if (player.finishedPlace !== undefined) return "已出完";
  if (player.seatId === game.primaryAttacker) return "主攻";
  if (player.seatId === game.defender) return "防守";
  const attacker = game.players.find((candidate) => candidate.seatId === game.primaryAttacker);
  const defender = game.players.find((candidate) => candidate.seatId === game.defender);
  if (attacker && defender && attacker.teamId !== defender.teamId && player.teamId === attacker.teamId) return "协攻位";
  return null;
}

export function isRedactedForSelf(game: GameViewState): boolean {
  return game.players.every((player) => player.seatId === game.selfSeat || player.hand === undefined);
}

function card(cardId: string, suit: Suit, rank: Exclude<Rank, "smallJoker" | "bigJoker">, isTrump = false): CardView {
  return { cardId, suit, rank, isTrump };
}

function joker(cardId: string, rank: "smallJoker" | "bigJoker"): CardView {
  return { cardId, suit: "joker", rank, isTrump: false };
}

const activeSelfHand: CardView[] = [
  card("self-s4", "spade", 4),
  card("self-s11", "spade", 11),
  card("self-h2", "heart", 2, true),
  card("self-h11", "heart", 11, true),
  card("self-c7", "club", 7),
  card("self-d7", "diamond", 7),
  card("self-d14", "diamond", 14),
  joker("self-big-joker", "bigJoker")
];

const lateSelfHand: CardView[] = [
  card("late-c10", "club", 10, true),
  card("late-d12", "diamond", 12),
  joker("late-small-joker", "smallJoker")
];

export const demoGameScenarios: Record<DemoScenarioId, { label: string; game: GameViewState }> = {
  "active-round": {
    label: "攻防进行中",
    game: {
      revision: 18,
      phase: "await-continuation",
      selfSeat: 0,
      trumpSuit: "heart",
      bottomCard: card("bottom-heart-k", "heart", 13, true),
      drawPileCount: 14,
      mainTwoSwapAvailable: true,
      primaryAttacker: 0,
      defender: 1,
      players: [
        { seatId: 0, nickname: "大巴掌", teamId: 0, handCount: 8, hand: activeSelfHand, ready: true, online: true, controller: "human" },
        { seatId: 1, nickname: "临风", teamId: 1, handCount: 7, ready: true, online: true, controller: "human" },
        { seatId: 2, nickname: "南枝", teamId: 0, handCount: 6, ready: true, online: true, controller: "bot-fixed" },
        { seatId: 3, nickname: "北辰", teamId: 1, handCount: 9, ready: true, online: false, controller: "human-grace" }
      ],
      table: [
        { attackId: "attack-1", attacker: 0, attack: card("table-c7", "club", 7), defense: card("table-c11", "club", 11) },
        { attackId: "attack-2", attacker: 2, attack: card("table-d11", "diamond", 11), defense: card("table-h4", "heart", 4, true) },
        { attackId: "attack-3", attacker: 0, attack: card("table-s7", "spade", 7), defense: card("table-s13", "spade", 13) }
      ],
      finishedOrder: [],
      legalActions: [
        { type: "game:attack", cardIds: ["self-h11", "self-c7", "self-d7"] },
        { type: "game:stop-attack" },
        { type: "game:exchange-trump-two" }
      ],
      message: "轮到你追加进攻，也可以结束本轮"
    }
  },
  "late-game": {
    label: "牌堆已空",
    game: {
      revision: 46,
      phase: "await-defense",
      selfSeat: 1,
      trumpSuit: "club",
      drawPileCount: 0,
      mainTwoSwapAvailable: false,
      primaryAttacker: 2,
      defender: 3,
      players: [
        { seatId: 0, nickname: "临风", teamId: 0, handCount: 0, ready: true, online: true, controller: "human", finishedPlace: 1 },
        { seatId: 1, nickname: "大巴掌", teamId: 1, handCount: 3, hand: lateSelfHand, ready: true, online: true, controller: "human" },
        { seatId: 2, nickname: "南枝", teamId: 0, handCount: 6, ready: true, online: true, controller: "bot-takeover" },
        { seatId: 3, nickname: "北辰", teamId: 1, handCount: 5, ready: true, online: false, controller: "human-grace" }
      ],
      table: [
        { attackId: "late-attack-1", attacker: 2, attack: card("late-table-h10", "heart", 10), defense: card("late-table-h12", "heart", 12) },
        { attackId: "late-attack-2", attacker: 2, attack: card("late-table-s12", "spade", 12) }
      ],
      finishedOrder: [0],
      legalActions: [],
      message: "等待对家防守；牌堆已空，本轮后不再补牌"
    }
  }
};
