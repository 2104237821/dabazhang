import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadServerConfig } from "./config.js";
import { createGameServer, registerShutdownSignals } from "./server.js";

export { loadServerConfig } from "./config.js";
export type { ServerConfig } from "./config.js";
export { createGameServer, registerShutdownSignals } from "./server.js";
export type {
  CreateGameServerOptions,
  GameServer,
  ListenOptions,
  ShutdownSignalEmitter
} from "./server.js";
export { RoomCommandError, RoomManager } from "./room-manager.js";
export type {
  RoomManagerOptions,
  RoomChangedHandler,
  RoomMutationResult,
  SocketSnapshot,
  StartGameContext,
  StartGameHandler,
  StartGameSeat
} from "./room-manager.js";

const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === entrypoint) {
  const config = loadServerConfig(process.env);
  const server = createGameServer({
    logger: true,
    commandRateLimit: {
      max: config.commandRateLimitMax,
      windowMs: config.commandRateLimitWindowMs
    },
    enableHsts: config.enableHsts,
    roomManagerOptions: {
      decisionTimeoutMs: config.actionTimeoutMs,
      disconnectGraceMs: config.disconnectGraceMs,
      maxActiveRooms: config.maxActiveRooms,
      botDelayMs: () => randomInt(config.botDelayMinMs, config.botDelayMaxMs + 1)
    },
    ...(config.publicOrigin === undefined ? {} : { allowedOrigin: config.publicOrigin }),
    ...(config.staticRoot === undefined ? {} : { staticRoot: config.staticRoot })
  });
  const disposeSignals = registerShutdownSignals(server);

  server.listen({ host: config.host, port: config.port }).catch((error: unknown) => {
    disposeSignals();
    console.error(error);
    process.exitCode = 1;
  });
}
