// Run/lease timing configuration (stage 2 PR5).
//
// The lease TTL and the heartbeat interval are policy values, not code
// constants: stage-2 fixes them through SEL-18/SEL-19 test results. This module
// is the only place that holds the numbers; runs.ts and commands/runs.ts read
// them from an injected RunConfig. It performs no database access.

export interface RunConfig {
  lease_ttl_ms: number;
  heartbeat_interval_ms: number;
}

/** Settings default until the stage-0 runner tests settle the real values. */
const DEFAULT_RUN_CONFIG: RunConfig = Object.freeze({
  lease_ttl_ms: 120_000,
  heartbeat_interval_ms: 30_000,
});

const LEASE_TTL_ENV = "PES_LEASE_TTL_MS";
const HEARTBEAT_INTERVAL_ENV = "PES_HEARTBEAT_INTERVAL_MS";

function require_positive_integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function parse_env_integer(text: string, field: string): number {
  if (!/^[0-9]+$/.test(text)) {
    throw new RangeError(`${field} must be a positive integer string`);
  }
  return require_positive_integer(Number(text), field);
}

function pick(
  override: number | undefined,
  env_value: string | undefined,
  fallback: number,
  field: string,
): number {
  if (override !== undefined) return require_positive_integer(override, field);
  if (env_value !== undefined) return parse_env_integer(env_value, field);
  return fallback;
}

/**
 * Resolve the run timing configuration once per service.
 *
 * Precedence: overrides > environment (`PES_LEASE_TTL_MS`,
 * `PES_HEARTBEAT_INTERVAL_MS`) > settings default. Every value must be a
 * positive safe integer, and the heartbeat must be more frequent than expiry.
 */
export function resolve_run_config(
  overrides?: Partial<RunConfig>,
  env: Record<string, string | undefined> = {},
): RunConfig {
  const env_map = env ?? {};
  const lease_ttl_ms = pick(
    overrides?.lease_ttl_ms,
    env_map[LEASE_TTL_ENV],
    DEFAULT_RUN_CONFIG.lease_ttl_ms,
    "lease_ttl_ms",
  );
  const heartbeat_interval_ms = pick(
    overrides?.heartbeat_interval_ms,
    env_map[HEARTBEAT_INTERVAL_ENV],
    DEFAULT_RUN_CONFIG.heartbeat_interval_ms,
    "heartbeat_interval_ms",
  );
  if (heartbeat_interval_ms >= lease_ttl_ms) {
    throw new RangeError("heartbeat_interval_ms must be smaller than lease_ttl_ms");
  }
  return { lease_ttl_ms, heartbeat_interval_ms };
}
