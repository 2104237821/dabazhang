import { describe, expect, it } from "vitest";

import { loadServerConfig } from "./config.js";

describe("server configuration", () => {
  it("uses documented safe defaults and disables cross-origin access", () => {
    expect(loadServerConfig({})).toEqual({
      actionTimeoutMs: 45_000,
      botDelayMaxMs: 900,
      botDelayMinMs: 500,
      commandRateLimitMax: 60,
      commandRateLimitWindowMs: 10_000,
      disconnectGraceMs: 60_000,
      enableHsts: false,
      host: "0.0.0.0",
      nodeEnv: "development",
      port: 3_000,
      publicOrigin: undefined,
      staticRoot: undefined
    });
  });

  it("parses explicit production settings without silently changing them", () => {
    expect(
      loadServerConfig({
        ACTION_TIMEOUT_MS: "30000",
        BOT_DELAY_MAX_MS: "1200",
        BOT_DELAY_MIN_MS: "250",
        COMMAND_RATE_LIMIT_MAX: "25",
        COMMAND_RATE_LIMIT_WINDOW_MS: "5000",
        DISCONNECT_GRACE_MS: "45000",
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        PORT: "8080",
        PUBLIC_ORIGIN: "https://cards.example.com",
        STATIC_ROOT: "/srv/dabazhang/web"
      })
    ).toEqual({
      actionTimeoutMs: 30_000,
      botDelayMaxMs: 1_200,
      botDelayMinMs: 250,
      commandRateLimitMax: 25,
      commandRateLimitWindowMs: 5_000,
      disconnectGraceMs: 45_000,
      enableHsts: true,
      host: "127.0.0.1",
      nodeEnv: "production",
      port: 8_080,
      publicOrigin: "https://cards.example.com",
      staticRoot: "/srv/dabazhang/web"
    });
  });

  it.each([
    [{ PORT: "0" }, "PORT"],
    [{ PORT: "65536" }, "PORT"],
    [{ ACTION_TIMEOUT_MS: "999" }, "ACTION_TIMEOUT_MS"],
    [{ DISCONNECT_GRACE_MS: "nope" }, "DISCONNECT_GRACE_MS"],
    [{ BOT_DELAY_MIN_MS: "1000", BOT_DELAY_MAX_MS: "500" }, "BOT_DELAY_MAX_MS"],
    [{ COMMAND_RATE_LIMIT_MAX: "0" }, "COMMAND_RATE_LIMIT_MAX"],
    [{ PUBLIC_ORIGIN: "https://cards.example.com/path" }, "PUBLIC_ORIGIN"],
    [{ PUBLIC_ORIGIN: "*" }, "PUBLIC_ORIGIN"]
  ])("rejects invalid or unsafe configuration %j", (environment, field) => {
    expect(() => loadServerConfig(environment)).toThrow(field);
  });
});
