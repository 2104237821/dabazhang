import { isAbsolute } from "node:path";

import { z } from "zod";

export interface ServerConfig {
  actionTimeoutMs: number;
  botDelayMaxMs: number;
  botDelayMinMs: number;
  commandRateLimitMax: number;
  commandRateLimitWindowMs: number;
  disconnectGraceMs: number;
  enableHsts: boolean;
  host: string;
  maxActiveRooms: number;
  nodeEnv: "development" | "production" | "test";
  port: number;
  publicOrigin?: string;
  staticRoot?: string;
}

type Environment = Record<string, string | undefined>;

const nodeEnvironmentSchema = z.enum(["development", "production", "test"]);

export function loadServerConfig(environment: Environment): ServerConfig {
  const nodeEnv = parseField(
    "NODE_ENV",
    nodeEnvironmentSchema,
    environment.NODE_ENV ?? "development"
  );
  const botDelayMinMs = parseInteger(environment, "BOT_DELAY_MIN_MS", 500, 0, 60_000);
  const botDelayMaxMs = parseInteger(environment, "BOT_DELAY_MAX_MS", 900, 0, 60_000);
  if (botDelayMaxMs < botDelayMinMs) {
    throw new Error("BOT_DELAY_MAX_MS must be greater than or equal to BOT_DELAY_MIN_MS");
  }

  const publicOrigin = parsePublicOrigin(environment.PUBLIC_ORIGIN);
  const staticRoot = parseStaticRoot(environment.STATIC_ROOT);

  return {
    actionTimeoutMs: parseInteger(environment, "ACTION_TIMEOUT_MS", 45_000, 1_000, 600_000),
    botDelayMaxMs,
    botDelayMinMs,
    commandRateLimitMax: parseInteger(environment, "COMMAND_RATE_LIMIT_MAX", 60, 1, 10_000),
    commandRateLimitWindowMs: parseInteger(
      environment,
      "COMMAND_RATE_LIMIT_WINDOW_MS",
      10_000,
      100,
      600_000
    ),
    disconnectGraceMs: parseInteger(
      environment,
      "DISCONNECT_GRACE_MS",
      60_000,
      1_000,
      3_600_000
    ),
    enableHsts: nodeEnv === "production",
    host: parseHost(environment.HOST),
    maxActiveRooms: parseInteger(environment, "MAX_ACTIVE_ROOMS", 500, 1, 100_000),
    nodeEnv,
    port: parseInteger(environment, "PORT", 3_000, 1, 65_535),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(staticRoot === undefined ? {} : { staticRoot })
  };
}

function parseInteger(
  environment: Environment,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[field];
  if (raw === undefined || raw === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${field} must be an integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parsePublicOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "*") throw new Error("PUBLIC_ORIGIN must be an explicit http(s) origin");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a valid URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("PUBLIC_ORIGIN must contain only an http(s) origin");
  }
  return url.origin;
}

function parseStaticRoot(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!isAbsolute(raw)) throw new Error("STATIC_ROOT must be an absolute path");
  return raw;
}

function parseHost(raw: string | undefined): string {
  const host = raw?.trim() ?? "";
  if (host === "") return "0.0.0.0";
  if (/\s|[/\\]/.test(host)) throw new Error("HOST must be a hostname or IP address");
  return host;
}

function parseField<T>(field: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${field} is invalid`);
  return parsed.data;
}
