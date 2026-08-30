import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { PlayerView, RoomView, SeatId } from "@dabazhang/protocol";
import {
  getPlayerAtSeat,
  getSeatLabel,
  getStartBlocker,
  normalizeRoomCode,
  seatToPosition,
  validateNickname,
  validateRoomCode
} from "./lobby.js";
import type { LobbyClient, TablePosition } from "./lobby.js";
import type { ConnectionState } from "./gameClient.js";
import { GameDemoScreen, GameInteractionScreen } from "./gameInteraction.js";
import { SocketGameClient } from "./socketClient.js";
import type { SocketClientState } from "./socketClient.js";

type EntryMode = "create" | "join";

const seatIds = [0, 1, 2, 3] as const;
let defaultRealtimeClient: SocketGameClient | undefined;

interface AppProps {
  client?: LobbyClient;
  realtimeClient?: SocketGameClient;
}

export function App({ client: injectedClient, realtimeClient: injectedRealtimeClient }: AppProps) {
  const realtimeClient = injectedClient === undefined
    ? injectedRealtimeClient ?? getDefaultRealtimeClient()
    : null;
  const client: LobbyClient = injectedClient ?? realtimeClient ?? missingLobbyClient();

  const [localRoom, setLocalRoom] = useState<RoomView | null>(null);
  const [socketState, setSocketState] = useState<SocketClientState | null>(() => realtimeClient?.getState() ?? null);
  const [gameDemoOpen, setGameDemoOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [message, setMessage] = useState("");
  const room = socketState?.snapshot?.room ?? localRoom;
  const snapshot = socketState?.snapshot;
  const connectionState: ConnectionState = socketState?.connectionState ?? "connected";

  useEffect(() => {
    if (realtimeClient === null) return;
    return realtimeClient.subscribe(setSocketState);
  }, [realtimeClient]);

  useEffect(() => {
    if (socketState?.terminalError) {
      setLocalRoom(null);
      setMessage(socketState.terminalError);
      return;
    }
    if (socketState?.notice) setMessage(socketState.notice);
  }, [socketState?.notice, socketState?.terminalError]);

  useEffect(() => {
    document.title = gameDemoOpen ? "牌桌演示 · 打八张" : room ? `房间 ${room.roomCode} · 打八张` : "打八张 · 四人对家牌局";
  }, [gameDemoOpen, room]);

  async function leaveRoom() {
    if (room === null) return;
    try {
      await client.leaveRoom(room);
      setLocalRoom(null);
      setMessage(room.status === "lobby" ? "已离开房间" : "已离开本局，座位将由机器人接管");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "离开房间失败，请重试");
    }
  }

  const liveGame = !gameDemoOpen && snapshot !== undefined && room?.status !== "lobby";

  return (
    <>
      <div className="app-shell">
        <SiteHeader
          badge={gameDemoOpen ? "脱敏演示" : room ? connectionLabel(connectionState, socketState?.restoring) : undefined}
          onOpenRules={() => setRulesOpen(true)}
        />
        {gameDemoOpen ? (
          <GameDemoScreen onExit={() => setGameDemoOpen(false)} />
        ) : liveGame && realtimeClient !== null ? (
          <GameInteractionScreen
            snapshot={snapshot}
            client={realtimeClient}
            connectionState={connectionState}
            connectionGeneration={socketState?.connectionGeneration ?? 0}
            modeLabel={`联网房间 ${snapshot.room.roomCode}`}
            onExit={() => void leaveRoom()}
            exitLabel="离开本局（机器人接管）"
          />
        ) : room ? (
          <RoomScreen
            client={client}
            room={room}
            onRoomChange={setLocalRoom}
            onOpenGameDemo={() => setGameDemoOpen(true)}
            onLeave={() => void leaveRoom()}
            announce={setMessage}
            connectionState={connectionState}
          />
        ) : socketState?.restoring ? (
          <RestoreScreen connectionState={connectionState} />
        ) : (
          <HomeScreen
            client={client}
            onOpenGameDemo={() => setGameDemoOpen(true)}
            onEnterRoom={(nextRoom) => {
              setLocalRoom(nextRoom);
              setMessage(`已进入房间 ${nextRoom.roomCode}`);
            }}
            announce={setMessage}
          />
        )}
      </div>

      <RulesDrawer open={rulesOpen} onClose={() => setRulesOpen(false)} />
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
        {message}
      </div>
      <ViewportWarning />
    </>
  );
}

function connectionLabel(connection: ConnectionState, restoring = false): string {
  if (restoring) return "正在恢复牌桌";
  if (connection === "connected") return "服务器已连接";
  if (connection === "reconnecting") return "正在重连";
  return "连接已断开";
}

function getDefaultRealtimeClient(): SocketGameClient {
  defaultRealtimeClient ??= new SocketGameClient();
  return defaultRealtimeClient;
}

function missingLobbyClient(): never {
  throw new Error("缺少房间客户端");
}

function SiteHeader({ badge, onOpenRules }: { badge: string | undefined; onOpenRules: () => void }) {
  return (
    <header className="site-header">
      <div className="brand-lockup" aria-label="打八张">
        <span className="brand-mark" aria-hidden="true">八</span>
        <span>
          <strong>打八张</strong>
          <small>四人对家牌局</small>
        </span>
      </div>
      <nav aria-label="页面工具">
        {badge && <span className="local-badge">{badge}</span>}
        <button className="quiet-button" type="button" onClick={onOpenRules}>
          <span aria-hidden="true">?</span> 游戏规则
        </button>
      </nav>
    </header>
  );
}

function RestoreScreen({ connectionState }: { connectionState: ConnectionState }) {
  return (
    <main className="restore-page" role="status" aria-live="polite">
      <span className="restore-spinner" aria-hidden="true">八</span>
      <p className="eyebrow">恢复牌桌</p>
      <h1>{connectionState === "disconnected" ? "暂时无法连接服务器" : "正在回到上一局…"}</h1>
      <p>正在验证本机保存的恢复凭证，并同步最新的权威牌桌状态。</p>
    </main>
  );
}

function HomeScreen({ client, onEnterRoom, onOpenGameDemo, announce }: {
  client: LobbyClient;
  onEnterRoom: (room: RoomView) => void;
  onOpenGameDemo: () => void;
  announce: (message: string) => void;
}) {
  const [mode, setMode] = useState<EntryMode>("create");
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [errors, setErrors] = useState<{ nickname?: string; roomCode?: string }>({});
  const [pending, setPending] = useState(false);
  const nicknameHelpId = useId();
  const roomCodeHelpId = useId();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nicknameError = validateNickname(nickname);
    const roomCodeError = mode === "join" ? validateRoomCode(roomCode) : null;
    const nextErrors: { nickname?: string; roomCode?: string } = {};
    if (nicknameError) nextErrors.nickname = nicknameError;
    if (roomCodeError) nextErrors.roomCode = roomCodeError;
    setErrors(nextErrors);
    if (nicknameError || roomCodeError) return;

    setPending(true);
    try {
      const nextRoom = mode === "create"
        ? await client.createRoom(nickname)
        : await client.joinRoom(nickname, roomCode);
      onEnterRoom(nextRoom);
    } catch (error) {
      announce(error instanceof Error ? error.message : "无法进入房间，请重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="home-page">
      <section className="hero-copy" aria-labelledby="hero-title">
        <p className="eyebrow">逆时针攻防 · 对家并肩</p>
        <h1 id="hero-title">八张在手，<br /><span>一桌见真章。</span></h1>
        <p className="hero-intro">
          四名玩家，两组对家。判断花色、保住大牌，也别错过队友递来的那次协攻。
        </p>
        <ul className="feature-row" aria-label="游戏特点">
          <li><SuitToken suit="♠" /> 54 张完整牌组</li>
          <li><SuitToken suit="♥" /> 主花色攻防</li>
          <li><SuitToken suit="♣" /> 真人与机器人混合</li>
        </ul>
        <button className="table-demo-link" type="button" onClick={onOpenGameDemo}>
          查看脱敏牌桌演示 <span aria-hidden="true">→</span>
        </button>
      </section>

      <section className="entry-panel" aria-labelledby="entry-title">
        <div className="panel-corner panel-corner-one" aria-hidden="true">A<span>♠</span></div>
        <div className="panel-corner panel-corner-two" aria-hidden="true">8<span>♦</span></div>
        <div className="entry-heading">
          <p className="eyebrow">进入牌桌</p>
          <h2 id="entry-title">和朋友开一局</h2>
          <p>无需账号，用昵称和房间码即可入座。</p>
        </div>

        <div className="entry-tabs" role="tablist" aria-label="房间操作">
          <button
            id="create-tab"
            type="button"
            role="tab"
            aria-selected={mode === "create"}
            aria-controls="entry-form"
            onClick={() => {
              setMode("create");
              setErrors({});
            }}
          >
            创建房间
          </button>
          <button
            id="join-tab"
            type="button"
            role="tab"
            aria-selected={mode === "join"}
            aria-controls="entry-form"
            onClick={() => {
              setMode("join");
              setErrors({});
            }}
          >
            加入房间
          </button>
        </div>

        <form id="entry-form" className="entry-form" aria-labelledby={`${mode}-tab`} onSubmit={handleSubmit} noValidate>
          <label htmlFor="nickname">你的昵称</label>
          <input
            id="nickname"
            name="nickname"
            autoComplete="nickname"
            maxLength={32}
            value={nickname}
            onChange={(event) => {
              setNickname(event.target.value);
              if (errors.nickname) setErrors((current) => {
                const next = { ...current };
                delete next.nickname;
                return next;
              });
            }}
            aria-invalid={Boolean(errors.nickname)}
            aria-describedby={errors.nickname ? nicknameHelpId : undefined}
            placeholder="例如：大巴掌"
          />
          {errors.nickname && <p className="field-error" id={nicknameHelpId}>{errors.nickname}</p>}

          {mode === "join" && (
            <>
              <label htmlFor="room-code">六位房间码</label>
              <input
                id="room-code"
                name="roomCode"
                className="room-code-input"
                autoComplete="off"
                inputMode="text"
                maxLength={6}
                value={roomCode}
                onChange={(event) => {
                  setRoomCode(normalizeRoomCode(event.target.value));
                  if (errors.roomCode) setErrors((current) => {
                    const next = { ...current };
                    delete next.roomCode;
                    return next;
                  });
                }}
                aria-invalid={Boolean(errors.roomCode)}
                aria-describedby={errors.roomCode ? roomCodeHelpId : undefined}
                placeholder="例如 BZ8K2Q"
              />
              {errors.roomCode && <p className="field-error" id={roomCodeHelpId}>{errors.roomCode}</p>}
            </>
          )}

          <button className="primary-button entry-submit" type="submit" disabled={pending}>
            {pending ? "正在入座…" : mode === "create" ? "创建牌桌" : "加入牌桌"}
          </button>
        </form>

        <p className="entry-note"><span aria-hidden="true">●</span> 房间实时同步；刷新页面会自动尝试恢复本人的座位。</p>
      </section>
    </main>
  );
}

function SuitToken({ suit }: { suit: string }) {
  return <span className={suit === "♥" || suit === "♦" ? "suit-token red" : "suit-token"} aria-hidden="true">{suit}</span>;
}

interface RoomScreenProps {
  client: LobbyClient;
  room: RoomView;
  onRoomChange: (room: RoomView) => void;
  onOpenGameDemo: () => void;
  onLeave: () => void;
  announce: (message: string) => void;
  connectionState: ConnectionState;
}

function RoomScreen({ client, room, onRoomChange, onOpenGameDemo, onLeave, announce, connectionState }: RoomScreenProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const interactionDisabled = pendingAction !== null || connectionState !== "connected";
  const self = getPlayerAtSeat(room, room.selfSeat);
  const isHost = room.selfSeat === room.hostSeat;
  const blocker = getStartBlocker(room);
  const occupied = room.players.length;
  const readyHumans = room.players.filter((player) => player.controller !== "bot-fixed" && player.ready).length;
  const humanCount = room.players.filter((player) => player.controller !== "bot-fixed").length;

  async function runAction(label: string, action: () => Promise<RoomView>, successMessage: string) {
    setPendingAction(label);
    try {
      const nextRoom = await action();
      onRoomChange(nextRoom);
      announce(successMessage);
    } catch (error) {
      announce(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      setPendingAction(null);
    }
  }

  async function copyRoomCode() {
    try {
      await navigator.clipboard.writeText(room.roomCode);
      announce(`房间码 ${room.roomCode} 已复制`);
    } catch {
      announce(`复制失败，请手动记录房间码 ${room.roomCode}`);
    }
  }

  return (
    <main className="room-page">
      <div className="room-meta">
        <div>
          <p className="eyebrow">等待房间</p>
          <h1>四方已摆好，只等人齐</h1>
        </div>
        <button className="quiet-button leave-button" type="button" disabled={interactionDisabled} onClick={onLeave}>离开房间</button>
      </div>

      <section className="table-frame" aria-label={`房间 ${room.roomCode} 的四人牌桌`} aria-busy={pendingAction !== null}>
        <div className="table-felt">
          <div className="felt-ornament felt-ornament-one" aria-hidden="true">♣</div>
          <div className="felt-ornament felt-ornament-two" aria-hidden="true">♦</div>
          {seatIds.map((seatId) => {
            const position = seatToPosition(seatId, room.selfSeat);
            return (
              <Seat
                key={seatId}
                seatId={seatId}
                position={position}
                player={getPlayerAtSeat(room, seatId)}
                selfSeat={room.selfSeat}
                hostSeat={room.hostSeat}
                isHost={isHost}
                disabled={interactionDisabled || room.status !== "lobby"}
                onRemoveBot={(botSeat) => void runAction(
                  "remove-bot",
                  () => client.removeBot(room, botSeat),
                  "机器人已离开座位"
                )}
              />
            );
          })}

          <div className="room-center" aria-live="polite">
            <p className="center-kicker">{room.status === "playing" ? "对局即将开始" : `${occupied} / 4 已入座`}</p>
            <div className="room-code-block">
              <span>房间码</span>
              <strong>{room.roomCode}</strong>
              <button type="button" onClick={() => void copyRoomCode()} aria-label={`复制房间码 ${room.roomCode}`}>
                复制
              </button>
            </div>
            {room.status === "playing" ? (
              <div className="table-placeholder">
                <span className="trump-placeholder" aria-hidden="true">主</span>
                <h2>房间已开始</h2>
                <p>服务端接入前，可先查看脱敏状态驱动的牌桌。</p>
                <button type="button" onClick={onOpenGameDemo}>进入牌桌演示</button>
              </div>
            ) : (
              <>
                <div className="team-legend" aria-label="队伍座位">
                  <span><i className="team-dot team-dot-blue" />你与对家</span>
                  <span><i className="team-dot team-dot-copper" />左右两家</span>
                </div>
                <p className="ready-summary">真人已准备 {readyHumans} / {humanCount}</p>
                {connectionState !== "connected" && (
                  <p className="ready-summary" role="status">{connectionLabel(connectionState)}，房间操作已暂停</p>
                )}
              </>
            )}
          </div>
        </div>
      </section>

      <div className="room-actions" aria-label="房间操作">
        {room.status === "lobby" && self && (
          <button
            className={self.ready ? "secondary-button ready-button is-ready" : "secondary-button ready-button"}
            type="button"
            disabled={interactionDisabled}
            aria-pressed={self.ready}
            onClick={() => void runAction(
              "ready",
              () => client.setReady(room, !self.ready),
              self.ready ? "已取消准备" : "你已准备"
            )}
          >
            {self.ready ? "✓ 已准备" : "我准备好了"}
          </button>
        )}

        {room.status === "lobby" && isHost && (
          <>
            <button
              className="secondary-button"
              type="button"
              disabled={interactionDisabled || occupied === 4}
              onClick={() => void runAction("add-bot", () => client.addBot(room), "机器人已入座")}
            >
              添加机器人
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={interactionDisabled || occupied === 4}
              onClick={() => void runAction("fill-bots", () => client.fillBots(room), "机器人已补满空位")}
            >
              补满机器人
            </button>
            <div className="start-action">
              <button
                className="primary-button"
                type="button"
                disabled={interactionDisabled || blocker !== null}
                aria-describedby={blocker ? "start-blocker" : undefined}
                onClick={() => void runAction("start", () => client.startRoom(room), "房间已开始")}
              >
                开始游戏
              </button>
              {blocker && <span id="start-blocker">{blocker}</span>}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

interface SeatProps {
  seatId: SeatId;
  position: TablePosition;
  player: PlayerView | undefined;
  selfSeat: SeatId;
  hostSeat: SeatId;
  isHost: boolean;
  disabled: boolean;
  onRemoveBot: (seatId: SeatId) => void;
}

function Seat({ seatId, position, player, selfSeat, hostSeat, isHost, disabled, onRemoveBot }: SeatProps) {
  const isSelf = seatId === selfSeat;
  const isTeammate = seatId % 2 === selfSeat % 2;
  const status = player
    ? player.controller === "bot-fixed"
      ? "机器人 · 已就绪"
      : player.controller === "bot-takeover"
        ? "离线 · 机器人接管"
        : player.controller === "human-grace" || !player.online
          ? player.ready ? "离线 · 已准备" : "离线 · 未准备"
          : player.ready ? "已准备" : "未准备"
    : "等待入座";
  const initials = player ? Array.from(player.nickname.replace(/^房主·|^机器人·/, "")).slice(0, 2).join("") : "+";

  return (
    <article className={`player-seat player-seat-${position} ${isTeammate ? "team-blue" : "team-copper"}`} aria-label={`${getSeatLabel(position)}，${player ? `${player.nickname}，${status}` : status}`}>
      <div className="seat-rack" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => <i key={index} />)}
      </div>
      <div className="seat-card">
        <div className="avatar" aria-hidden="true">{initials}</div>
        <div className="seat-copy">
          <span className="seat-label">{getSeatLabel(position)}</span>
          <strong>{player?.nickname ?? "空座位"}</strong>
          <small className={player?.ready || player?.controller === "bot-fixed" ? "ready" : ""}>{status}</small>
        </div>
        <div className="seat-badges">
          {seatId === hostSeat && player && <span className="host-badge">房主</span>}
          {isSelf && <span className="self-badge">本人</span>}
        </div>
        {isHost && player?.controller === "bot-fixed" && (
          <button className="remove-bot" type="button" disabled={disabled} onClick={() => onRemoveBot(seatId)}>
            移除
          </button>
        )}
      </div>
    </article>
  );
}

function RulesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={panelRef} className="rules-drawer" role="dialog" aria-modal="true" aria-labelledby="rules-title">
        <div className="drawer-heading">
          <div>
            <p className="eyebrow">快速上手</p>
            <h2 id="rules-title">打八张规则</h2>
          </div>
          <button ref={closeRef} className="close-button" type="button" onClick={onClose} aria-label="关闭规则">×</button>
        </div>
        <RuleSection number="01" title="四人两队">
          四人逆时针行动，对面两人为队友。每人初始八张牌；牌堆有牌时，每轮结束后按顺序补到八张。
        </RuleSection>
        <RuleSection number="02" title="主花色攻防">
          开局翻出一张非王牌决定固定主花色。防守通常用同花色更大牌，无法同花色压制时可用主牌；大小王可防守任何牌，但不能进攻。
        </RuleSection>
        <RuleSection number="03" title="同点追加与协攻">
          追加牌点数必须已经出现在本轮桌面。主攻攻击敌方时，队友可申请协攻，由主攻决定是否批准。
        </RuleSection>
        <RuleSection number="04" title="主2换底">
          主花色的 2 可在合法时机与公开底牌交换，整局最多成功一次；交换不会改变主花色。
        </RuleSection>
        <RuleSection number="05" title="出完获胜">
          牌堆为空、手牌为空且本轮结算完成才算正式出完。同队两名玩家都正式出完，即获得本局胜利。
        </RuleSection>
        <p className="rules-note">完整规则将在游戏中始终可打开查看。</p>
      </aside>
    </div>
  );
}

function RuleSection({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <section className="rule-section">
      <span aria-hidden="true">{number}</span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </section>
  );
}

function ViewportWarning() {
  function keepFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") event.preventDefault();
  }

  return (
    <div className="viewport-warning" role="alertdialog" aria-modal="true" aria-labelledby="viewport-title" onKeyDown={keepFocus} tabIndex={-1}>
      <div className="viewport-card">
        <span aria-hidden="true">↔</span>
        <h2 id="viewport-title">需要更大的牌桌</h2>
        <p>请将浏览器窗口调整至至少 1100 × 650。本游戏首版仅支持电脑横向屏幕。</p>
      </div>
    </div>
  );
}
