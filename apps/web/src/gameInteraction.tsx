import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GameCommandType, GameViewState, StateSnapshot } from "@dabazhang/protocol";
import {
  applyCommandAck,
  applyTransportError,
  createInteractionState,
  defaultRequestIdFactory,
  getDecisionSecondsRemaining,
  getDefendableAttackIds,
  getLegalAction,
  getPresenceNotice,
  getWinnerSummary,
  isSubmissionLocked,
  makeSubmissionRetryable,
  prepareGameCommand,
  reconcileGameSnapshot,
  selectCard,
  selectDefenseTarget,
  submissionMessage
} from "./gameClient.js";
import type {
  ConnectionState,
  GameClient,
  GameIntent,
  InteractionState,
  RequestIdFactory
} from "./gameClient.js";
import { demoGameScenarios, describeCard } from "./gameTable.js";
import type { DemoScenarioId } from "./gameTable.js";
import { GameStatusBanner, GameTable } from "./gameTableComponents.js";

function hasAction(game: GameViewState, type: GameCommandType): boolean {
  return getLegalAction(game, type) !== undefined;
}

export function GameActionPanel({ game, interaction, onIntent, disabled = false }: {
  game: GameViewState;
  interaction: InteractionState;
  onIntent: (intent: GameIntent) => void;
  disabled?: boolean;
}) {
  const submissionLocked = isSubmissionLocked(interaction.submission);
  const locked = disabled || submissionLocked;
  const message = submissionMessage(interaction.submission);
  const selectedCardId = interaction.selectedCardId;
  const attackAction = getLegalAction(game, "game:attack");
  const defendAction = getLegalAction(game, "game:defend");
  const assistAction = getLegalAction(game, "game:assist-propose");
  const canAttack = selectedCardId !== undefined && attackAction?.cardIds?.includes(selectedCardId) === true;
  const canDefend = selectedCardId !== undefined
    && interaction.selectedAttackId !== undefined
    && defendAction?.cardIds?.includes(selectedCardId) === true
    && getDefendableAttackIds(game).has(interaction.selectedAttackId);
  const canAssist = selectedCardId !== undefined && assistAction?.cardIds?.includes(selectedCardId) === true;
  const assistProposal = game.assistProposal;

  function actionButton(label: string, intent: GameIntent, enabled = true, tone = "secondary"): ReactNode {
    return (
      <button
        type="button"
        className={`game-action game-action-${tone}`}
        disabled={locked || !enabled}
        onClick={() => onIntent(intent)}
      >
        {label}
      </button>
    );
  }

  return (
    <section className="game-action-panel" aria-label="本次操作" aria-busy={submissionLocked}>
      <div className="game-action-buttons">
        {attackAction && actionButton(
          game.phase === "await-opening-attack" ? "首攻出牌" : "追加进攻",
          { type: "game:attack", cardId: selectedCardId ?? "" },
          canAttack,
          "primary"
        )}
        {defendAction && actionButton(
          "用所选牌防守",
          { type: "game:defend", attackId: interaction.selectedAttackId ?? "", cardId: selectedCardId ?? "" },
          canDefend,
          "primary"
        )}
        {assistAction && actionButton(
          "请求队友协攻",
          { type: "game:assist-propose", cardId: selectedCardId ?? "" },
          canAssist
        )}
        {hasAction(game, "game:take") && actionButton("主动收牌", { type: "game:take" }, true, "danger")}
        {hasAction(game, "game:stop-attack") && actionButton("结束进攻", { type: "game:stop-attack" })}
        {hasAction(game, "game:pass-attack") && actionButton("只剩王，跳过进攻", { type: "game:pass-attack" })}
        {hasAction(game, "game:exchange-trump-two") && actionButton("主2换取底牌", { type: "game:exchange-trump-two" }, true, "primary")}
        {hasAction(game, "game:decline-trump-two") && actionButton("保留主2", { type: "game:decline-trump-two" })}
      </div>

      {assistProposal && hasAction(game, "game:assist-decide") && (
        <div className="assist-approval" aria-label="协攻审批">
          <span>
            {game.players.find((player) => player.seatId === assistProposal.proposer)?.nickname ?? "队友"}
            请求用{describeCard(assistProposal.card)}协攻
          </span>
          {actionButton(
            "同意协攻",
            { type: "game:assist-decide", proposalId: assistProposal.proposalId, accepted: true },
            true,
            "primary"
          )}
          {actionButton(
            "拒绝协攻",
            { type: "game:assist-decide", proposalId: assistProposal.proposalId, accepted: false }
          )}
        </div>
      )}

      {message && (
        <p className={`game-action-message is-${interaction.submission.status}`} role={interaction.submission.status === "error" ? "alert" : "status"} aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}

export function GameRoundStatus({ game, serverTime, connectionState }: {
  game: GameViewState;
  serverTime: number;
  connectionState: ConnectionState;
}) {
  const [currentServerTime, setCurrentServerTime] = useState(serverTime);

  useEffect(() => {
    setCurrentServerTime(serverTime);
    if (game.decisionDeadline === undefined) return;
    const startedAt = Date.now();
    const timer = globalThis.setInterval(() => {
      setCurrentServerTime(serverTime + (Date.now() - startedAt));
    }, 250);
    return () => globalThis.clearInterval(timer);
  }, [game.decisionDeadline, serverTime]);

  const seconds = getDecisionSecondsRemaining(game.decisionDeadline, currentServerTime);
  const presenceNotice = getPresenceNotice(game, connectionState);
  return (
    <div className="game-round-status" aria-live="polite">
      <span>{seconds === undefined ? "等待牌桌状态" : seconds === 0 ? "操作即将由机器人代走一步" : `本次决定剩余 ${seconds} 秒`}</span>
      {presenceNotice && <strong>{presenceNotice}</strong>}
    </div>
  );
}

export function GameResultPanel({ game, interaction, onIntent, hostSeat, disabled = false }: {
  game: GameViewState;
  interaction: InteractionState;
  onIntent: (intent: GameIntent) => void;
  hostSeat: number;
  disabled?: boolean;
}) {
  const summary = getWinnerSummary(game);
  if (summary === undefined) return null;
  const locked = disabled || isSubmissionLocked(interaction.submission);
  const isHost = game.selfSeat === hostSeat;
  const finishNames = game.finishedOrder.map(
    (seatId) => game.players.find((player) => player.seatId === seatId)?.nickname ?? `${seatId}号座位`
  );
  return (
    <section className="game-result-panel" aria-labelledby="game-result-title">
      <p>本局结算</p>
      <h2 id="game-result-title">{summary.title}</h2>
      <strong>{summary.detail}</strong>
      <span>出完顺序：{finishNames.length > 0 ? finishNames.join(" → ") : "暂无"}</span>
      {isHost ? (
        <button type="button" disabled={locked} onClick={() => onIntent({ type: "match:play-again" })}>
          {isSubmissionLocked(interaction.submission) ? "正在准备…" : "再来一局"}
        </button>
      ) : (
        <span className="game-result-waiting">等待房主开始下一局</span>
      )}
    </section>
  );
}

export interface GameInteractionScreenProps {
  snapshot: StateSnapshot;
  client: GameClient;
  connectionState?: ConnectionState;
  connectionGeneration?: string | number;
  requestIdFactory?: RequestIdFactory;
  ackTimeoutMs?: number;
  modeLabel?: string;
  toolbarExtras?: ReactNode;
  onExit?: () => void;
}

export function GameInteractionScreen({
  snapshot,
  client,
  connectionState = "connected",
  connectionGeneration = 0,
  requestIdFactory = defaultRequestIdFactory,
  ackTimeoutMs = 10_000,
  modeLabel,
  toolbarExtras,
  onExit
}: GameInteractionScreenProps) {
  const game = snapshot.game;
  const [interaction, setInteraction] = useState<InteractionState>(() =>
    createInteractionState(game?.revision ?? snapshot.revision)
  );
  const interactionRef = useRef(interaction);
  const mountedRef = useRef(true);
  const previousSnapshotRef = useRef(snapshot);
  const previousConnectionGenerationRef = useRef(connectionGeneration);
  const activeRequestRef = useRef<{
    token: symbol;
    requestId: string;
    timeoutId: ReturnType<typeof globalThis.setTimeout>;
  } | null>(null);

  function updateInteraction(next: InteractionState) {
    if (!mountedRef.current) return;
    interactionRef.current = next;
    setInteraction(next);
  }

  function cancelActiveRequest() {
    const active = activeRequestRef.current;
    if (active !== null) globalThis.clearTimeout(active.timeoutId);
    activeRequestRef.current = null;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelActiveRequest();
    };
  }, []);

  useEffect(() => {
    if (previousSnapshotRef.current === snapshot) return;
    previousSnapshotRef.current = snapshot;
    if (game === undefined || game.revision < interactionRef.current.revision) return;
    cancelActiveRequest();
    updateInteraction(reconcileGameSnapshot(interactionRef.current, game));
  }, [snapshot]);

  useEffect(() => {
    const generationChanged = previousConnectionGenerationRef.current !== connectionGeneration;
    previousConnectionGenerationRef.current = connectionGeneration;
    if (connectionState === "connected" && !generationChanged) return;
    cancelActiveRequest();
    const message = connectionState === "connected"
      ? "连接已恢复，先前操作未确认，请按最新牌桌重试"
      : "连接已中断，先前操作未确认，请重连后重试";
    updateInteraction(makeSubmissionRetryable(interactionRef.current, message));
  }, [connectionGeneration, connectionState]);

  if (game === undefined) {
    return (
      <main className="game-page game-unavailable" role="status">
        <h1>牌局状态暂不可用</h1>
        <p>正在等待服务器发送完整牌桌快照。</p>
      </main>
    );
  }
  const currentGame = game;

  function handleSelectCard(cardId: string) {
    if (connectionState !== "connected") return;
    updateInteraction(selectCard(interactionRef.current, currentGame, cardId));
  }

  function handleSelectDefenseTarget(attackId: string) {
    if (connectionState !== "connected") return;
    updateInteraction(selectDefenseTarget(interactionRef.current, currentGame, attackId));
  }

  async function submitIntent(intent: GameIntent) {
    if (connectionState !== "connected") return;
    const requestId = requestIdFactory();
    const prepared = prepareGameCommand(currentGame, interactionRef.current, intent, requestId);
    updateInteraction(prepared.state);
    if (prepared.command === undefined) return;
    const token = Symbol(requestId);
    const timeoutId = globalThis.setTimeout(() => {
      if (!mountedRef.current || activeRequestRef.current?.token !== token) return;
      activeRequestRef.current = null;
      updateInteraction(applyTransportError(
        interactionRef.current,
        requestId,
        new Error("服务器确认超时，请重试")
      ));
    }, ackTimeoutMs);
    activeRequestRef.current = { token, requestId, timeoutId };
    try {
      const ack = await client.sendCommand(prepared.command);
      if (!mountedRef.current || activeRequestRef.current?.token !== token) return;
      globalThis.clearTimeout(timeoutId);
      activeRequestRef.current = null;
      updateInteraction(applyCommandAck(interactionRef.current, ack));
    } catch (error) {
      if (!mountedRef.current || activeRequestRef.current?.token !== token) return;
      globalThis.clearTimeout(timeoutId);
      activeRequestRef.current = null;
      updateInteraction(applyTransportError(interactionRef.current, requestId, error));
    }
  }

  return (
    <main className="game-page">
      <div className="game-toolbar">
        <GameStatusBanner game={game} />
        {(modeLabel || toolbarExtras || onExit) && (
          <div className="game-toolbar-tools">
            {modeLabel && <span className="game-mode-label">{modeLabel}</span>}
            {toolbarExtras}
            {onExit && <button className="quiet-button game-exit" type="button" onClick={onExit}>返回上一页</button>}
          </div>
        )}
      </div>

      <div className="game-play-area">
        <GameTable
          game={game}
          selectedCardId={interaction.selectedCardId ?? null}
          selectedAttackId={interaction.selectedAttackId ?? null}
          onSelectCard={handleSelectCard}
          onSelectDefenseTarget={handleSelectDefenseTarget}
          interactionDisabled={connectionState !== "connected"}
        />
        <GameResultPanel
          game={game}
          interaction={interaction}
          onIntent={(intent) => void submitIntent(intent)}
          hostSeat={snapshot.room.hostSeat}
          disabled={connectionState !== "connected"}
        />
      </div>

      <div className="game-command-dock">
        <GameRoundStatus game={game} serverTime={snapshot.serverTime} connectionState={connectionState} />
        <GameActionPanel
          game={game}
          interaction={interaction}
          onIntent={(intent) => void submitIntent(intent)}
          disabled={connectionState !== "connected"}
        />
      </div>
    </main>
  );
}

const demoClient: GameClient = {
  async sendCommand(command) {
    return {
      requestId: command.requestId,
      ok: false,
      error: { code: "ILLEGAL_ACTION", message: "本地脱敏演示：操作不会发送到服务器" }
    };
  }
};

export function GameDemoScreen({ onExit }: { onExit: () => void }) {
  const [scenarioId, setScenarioId] = useState<DemoScenarioId>("active-round");
  const scenario = demoGameScenarios[scenarioId];
  const game = scenario.game;
  const snapshot: StateSnapshot = {
    revision: game.revision,
    serverTime: Date.now(),
    room: {
      roomCode: "DEMO88",
      status: game.phase === "finished" ? "post-game" : "playing",
      hostSeat: 0,
      selfSeat: game.selfSeat,
      players: game.players
    },
    game
  };

  return (
    <GameInteractionScreen
      key={scenarioId}
      snapshot={snapshot}
      client={demoClient}
      modeLabel="本地脱敏演示"
      toolbarExtras={(
        <div className="demo-tools">
          <div className="demo-switcher" role="group" aria-label="切换脱敏牌桌演示状态">
            {(Object.entries(demoGameScenarios) as Array<[DemoScenarioId, typeof scenario]>).map(([id, item]) => (
              <button key={id} type="button" aria-pressed={scenarioId === id} onClick={() => setScenarioId(id)}>
                {item.label}
              </button>
            ))}
          </div>
          <small>操作不会发送到服务器</small>
        </div>
      )}
      onExit={onExit}
    />
  );
}
