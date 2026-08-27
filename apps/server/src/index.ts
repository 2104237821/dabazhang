import { fileURLToPath } from "node:url";

import { createGameServer } from "./server.js";

export { createGameServer } from "./server.js";
export type {
  CreateGameServerOptions,
  GameServer,
  ListenOptions
} from "./server.js";
export { RoomCommandError, RoomManager } from "./room-manager.js";
export type {
  RoomManagerOptions,
  RoomMutationResult,
  SocketSnapshot,
  StartGameContext,
  StartGameHandler,
  StartGameSeat
} from "./room-manager.js";

const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === entrypoint) {
  const server = createGameServer({
    logger: true,
    ...(process.env.PUBLIC_ORIGIN === undefined
      ? {}
      : { allowedOrigin: process.env.PUBLIC_ORIGIN })
  });
  const parsedPort = Number.parseInt(process.env.PORT ?? "3000", 10);
  const port = Number.isSafeInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;

  server.listen({ host: "0.0.0.0", port }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
