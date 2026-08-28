import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AttackPairView, CardView, GameViewState, PlayerView, SeatId, Suit } from "@dabazhang/protocol";
import { seatToPosition } from "./lobby.js";
import type { TablePosition } from "./lobby.js";
import {
  demoGameScenarios,
  describeCard,
  getNextCardFocusIndex,
  getSelectableCardIds,
  phaseLabels,
  playerRoleLabel,
  playerStatusLabel,
  rankLabel,
  suitPresentation
} from "./gameTable.js";
import type { CardFocusKey, DemoScenarioId } from "./gameTable.js";

const tableSeatIds = [0, 1, 2, 3] as const;

export interface CardProps {
  card: CardView;
  size?: "normal" | "small";
  interactive?: boolean;
  selectable?: boolean;
  selected?: boolean;
  tabIndex?: number;
  onSelect?: () => void;
  onFocus?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef?: (node: HTMLButtonElement | null) => void;
}

export function Card({
  card,
  size = "normal",
  interactive = false,
  selectable = false,
  selected = false,
  tabIndex = 0,
  onSelect,
  onFocus,
  onKeyDown,
  buttonRef
}: CardProps) {
  const isJoker = card.suit === "joker";
  const suit = card.suit === "joker" ? null : suitPresentation[card.suit];
  const label = `${describeCard(card)}${interactive ? selectable ? "，可选择" : "，当前不可选择" : ""}`;
  const className = [
    "playing-card",
    `playing-card-${size}`,
    suit?.color === "red" ? "playing-card-red" : "",
    isJoker ? "playing-card-joker" : "",
    card.isTrump ? "is-trump" : "",
    selectable ? "is-selectable" : "",
    selected ? "is-selected" : ""
  ].filter(Boolean).join(" ");

  const face = (
    <>
      {card.isTrump && <span className="trump-corner" aria-hidden="true">主</span>}
      {isJoker ? (
        <>
          <span className="joker-star" aria-hidden="true">✦</span>
          <span className="joker-name" aria-hidden="true">{rankLabel(card.rank)}</span>
        </>
      ) : (
        <>
          <span className="card-corner card-corner-top" aria-hidden="true">
            <b>{rankLabel(card.rank)}</b><i>{suit?.symbol}</i>
          </span>
          <span className="card-suit" aria-hidden="true">{suit?.symbol}</span>
          <span className="card-corner card-corner-bottom" aria-hidden="true">
            <b>{rankLabel(card.rank)}</b><i>{suit?.symbol}</i>
          </span>
        </>
      )}
    </>
  );

  if (interactive) {
    return (
      <button
        ref={buttonRef}
        className={className}
        type="button"
        aria-label={label}
        aria-disabled={!selectable}
        aria-pressed={selected}
        tabIndex={tabIndex}
        onClick={() => selectable && onSelect?.()}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      >
        {face}
      </button>
    );
  }

  return <div className={className} role="img" aria-label={label}>{face}</div>;
}

interface OwnHandProps {
  cards: CardView[];
  selectableCardIds: Set<string>;
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
}

export function OwnHand({ cards, selectableCardIds, selectedCardId, onSelectCard }: OwnHandProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setFocusIndex((current) => Math.min(current, Math.max(0, cards.length - 1)));
    cardRefs.current.length = cards.length;
  }, [cards.length]);

  function handleNavigation(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys: CardFocusKey[] = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key as CardFocusKey)) return;
    event.preventDefault();
    const nextIndex = getNextCardFocusIndex(index, event.key as CardFocusKey, cards.length);
    setFocusIndex(nextIndex);
    cardRefs.current[nextIndex]?.focus();
  }

  if (cards.length === 0) {
    return <div className="own-hand-empty" role="status">手牌已打空</div>;
  }

  return (
    <div className="own-hand-scroll" aria-label={`我的手牌，共 ${cards.length} 张`}>
      <div className="own-hand" role="group" aria-label="使用左右方向键浏览手牌，回车选择">
        {cards.map((card, index) => (
          <Card
            key={card.cardId}
            card={card}
            interactive
            selectable={selectableCardIds.has(card.cardId)}
            selected={selectedCardId === card.cardId}
            tabIndex={focusIndex === index ? 0 : -1}
            buttonRef={(node) => { cardRefs.current[index] = node; }}
            onFocus={() => setFocusIndex(index)}
            onKeyDown={(event) => handleNavigation(event, index)}
            onSelect={() => onSelectCard(card.cardId)}
          />
        ))}
      </div>
    </div>
  );
}

export function OpponentHand({ count, position, ownerLabel = "其他玩家" }: {
  count: number;
  position: Exclude<TablePosition, "bottom">;
  ownerLabel?: string;
}) {
  const visibleCount = Math.min(Math.max(count, 0), 12);
  return (
    <div className={`opponent-hand opponent-hand-${position}`} role="img" aria-label={`${ownerLabel}的背面手牌，共 ${count} 张`}>
      {count === 0 ? (
        <span className="opponent-hand-empty" aria-hidden="true">已清空</span>
      ) : (
        Array.from({ length: visibleCount }, (_, index) => <i className="card-back" key={index} aria-hidden="true" />)
      )}
      {count > visibleCount && <span className="opponent-overflow" aria-hidden="true">+{count - visibleCount}</span>}
    </div>
  );
}

interface PlayerSeatProps {
  game: GameViewState;
  player: PlayerView;
  position: TablePosition;
  selectedCardId: string | null;
  selectableCardIds: Set<string>;
  onSelectCard: (cardId: string) => void;
}

export function PlayerSeat({ game, player, position, selectedCardId, selectableCardIds, onSelectCard }: PlayerSeatProps) {
  const isSelf = player.seatId === game.selfSeat;
  const isSameTeam = player.teamId === game.players.find((candidate) => candidate.seatId === game.selfSeat)?.teamId;
  const role = playerRoleLabel(game, player);
  const status = playerStatusLabel(player);
  const initials = Array.from(player.nickname).slice(0, 2).join("");
  const controllerClass = player.online ? "" : "is-offline";
  const finishedClass = player.finishedPlace !== undefined ? "is-finished" : "";

  return (
    <article
      className={`game-seat game-seat-${position} ${isSameTeam ? "game-team-blue" : "game-team-copper"} ${controllerClass} ${finishedClass}`}
      aria-label={`${position === "bottom" ? "我" : position === "top" ? "对家队友" : position === "left" ? "上家" : "下家"}，${player.nickname}，${status}${role ? `，${role}` : ""}`}
    >
      <div className="game-player-meta">
        <div className="game-avatar" aria-hidden="true">{initials}</div>
        <div className="game-player-copy">
          <strong>{player.nickname}</strong>
          <span>{status}</span>
        </div>
        <div className="game-player-badges">
          {isSelf && <span className="game-self-badge">本人</span>}
          {role && <span className={`game-role-badge role-${role === "主攻" ? "attack" : role === "防守" ? "defense" : "support"}`}>{role}</span>}
        </div>
      </div>
      {isSelf ? (
        <OwnHand
          cards={player.hand ?? []}
          selectableCardIds={selectableCardIds}
          selectedCardId={selectedCardId}
          onSelectCard={onSelectCard}
        />
      ) : (
        <OpponentHand
          count={player.handCount}
          position={position === "bottom" ? "top" : position}
          ownerLabel={`${isSameTeam ? "队友" : "对手"}${player.nickname}`}
        />
      )}
    </article>
  );
}

export function TrumpDeckCluster({ trumpSuit, bottomCard, drawPileCount, swapAvailable }: {
  trumpSuit: Suit;
  bottomCard: CardView | undefined;
  drawPileCount: number;
  swapAvailable: boolean;
}) {
  const trump = suitPresentation[trumpSuit];
  return (
    <section className="trump-deck-cluster" aria-label={`本局主花色为${trump.label}，牌堆剩余 ${drawPileCount} 张`}>
      <div className={`trump-suit-token ${trump.color === "red" ? "red" : ""}`} aria-hidden="true">
        <span>{trump.symbol}</span><b>主</b>
      </div>
      <div className="deck-visual">
        {bottomCard ? <Card card={bottomCard} size="small" /> : <span className="bottom-card-empty">底牌已摸走</span>}
        {drawPileCount > 0 && (
          <div className="draw-pile" aria-hidden="true">
            <i /><i /><i />
          </div>
        )}
      </div>
      <div className="deck-copy">
        <strong>{trump.label}为主</strong>
        <span>{drawPileCount > 0 ? `牌堆 ${drawPileCount} 张` : "牌堆已空"}</span>
        {swapAvailable && <em>主2可换底</em>}
      </div>
    </section>
  );
}

export function AttackPairGrid({ pairs, players }: { pairs: AttackPairView[]; players: PlayerView[] }) {
  const playerName = (seatId: SeatId) => players.find((player) => player.seatId === seatId)?.nickname ?? `座位 ${seatId}`;
  if (pairs.length === 0) return <div className="attack-grid-empty">等待主攻方出牌</div>;

  return (
    <div className="attack-pair-grid" role="list" aria-label={`桌面共有 ${pairs.length} 组攻防牌`}>
      {pairs.map((pair, index) => (
        <div
          className={`attack-pair ${pair.defense ? "is-covered" : "awaiting-defense"}`}
          key={pair.attackId}
          role="listitem"
          aria-label={`${playerName(pair.attacker)}用${describeCard(pair.attack)}进攻，${pair.defense ? `已被${describeCard(pair.defense)}防住` : "等待防守"}`}
        >
          <span className="attack-source">{index + 1} · {playerName(pair.attacker)}</span>
          <div className="attack-card"><Card card={pair.attack} size="small" /></div>
          {pair.defense ? (
            <div className="defense-card"><Card card={pair.defense} size="small" /></div>
          ) : (
            <span className="defense-slot">待防守</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function CenterArena({ game }: { game: GameViewState }) {
  return (
    <section className="center-arena" aria-label="桌面攻防区">
      <p className="center-message">{game.message}</p>
      <div className="center-arena-content">
        <TrumpDeckCluster
          trumpSuit={game.trumpSuit}
          bottomCard={game.bottomCard}
          drawPileCount={game.drawPileCount}
          swapAvailable={game.mainTwoSwapAvailable}
        />
        <AttackPairGrid pairs={game.table} players={game.players} />
      </div>
    </section>
  );
}

export function GameStatusBanner({ game }: { game: GameViewState }) {
  const attacker = game.players.find((player) => player.seatId === game.primaryAttacker);
  const defender = game.players.find((player) => player.seatId === game.defender);
  return (
    <div className="game-status-banner" role="status" aria-live="polite">
      <span className="phase-badge">{phaseLabels[game.phase]}</span>
      <strong>{game.message}</strong>
      <span className="turn-route">{attacker?.nickname ?? "主攻"} <i aria-hidden="true">↶</i> {defender?.nickname ?? "防守"}</span>
    </div>
  );
}

export function GameTable({ game, selectedCardId, onSelectCard }: {
  game: GameViewState;
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
}) {
  const selectableCardIds = useMemo(() => getSelectableCardIds(game), [game]);

  return (
    <section className="game-table-frame" aria-label="打八张四人牌桌">
      <div className="game-table-felt">
        <div className="game-felt-mark" aria-hidden="true">八</div>
        <div className="turn-direction" aria-hidden="true">逆时针 ↶</div>
        {tableSeatIds.map((seatId) => {
          const player = game.players.find((candidate) => candidate.seatId === seatId);
          if (!player) return null;
          return (
            <PlayerSeat
              key={seatId}
              game={game}
              player={player}
              position={seatToPosition(seatId, game.selfSeat)}
              selectedCardId={selectedCardId}
              selectableCardIds={selectableCardIds}
              onSelectCard={onSelectCard}
            />
          );
        })}
        <CenterArena game={game} />
      </div>
    </section>
  );
}

export function GameDemoScreen({ onExit }: { onExit: () => void }) {
  const [scenarioId, setScenarioId] = useState<DemoScenarioId>("active-round");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const game = demoGameScenarios[scenarioId].game;

  function switchScenario(nextScenario: DemoScenarioId) {
    setScenarioId(nextScenario);
    setSelectedCardId(null);
    setAnnouncement(`已切换到${demoGameScenarios[nextScenario].label}演示`);
  }

  function selectCard(cardId: string) {
    const nextSelection = selectedCardId === cardId ? null : cardId;
    setSelectedCardId(nextSelection);
    const card = game.players.find((player) => player.seatId === game.selfSeat)?.hand?.find((candidate) => candidate.cardId === cardId);
    setAnnouncement(nextSelection && card ? `已选择${describeCard(card)}` : "已取消选择");
  }

  return (
    <main className="game-page">
      <div className="game-toolbar">
        <GameStatusBanner game={game} />
        <div className="demo-switcher" role="group" aria-label="切换脱敏牌桌演示状态">
          {(Object.entries(demoGameScenarios) as Array<[DemoScenarioId, { label: string; game: GameViewState }]>).map(([id, scenario]) => (
            <button key={id} type="button" aria-pressed={scenarioId === id} onClick={() => switchScenario(id)}>{scenario.label}</button>
          ))}
        </div>
        <button className="quiet-button game-exit" type="button" onClick={onExit}>返回上一页</button>
      </div>

      <GameTable game={game} selectedCardId={selectedCardId} onSelectCard={selectCard} />

      <div className="game-preview-footer">
        <span role="status" aria-live="polite">{announcement || "可用左右方向键浏览手牌，回车选择高亮牌"}</span>
        <strong>{selectedCardId ? "已选牌 · 尚未发送" : "仅本地选牌预览"}</strong>
        <span>出牌、收牌与协攻命令将在交互模块接入</span>
      </div>
    </main>
  );
}
