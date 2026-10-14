/**
 * Atomic multi-bucket token bucket, evaluated entirely inside Redis (one EVAL = one atomic step, using Redis'
 * own clock so API instances with skewed clocks agree).
 *
 * KEYS[i]   — one hash per bucket: `level` (tokens available, fractional) and `at` (ms of last update).
 * ARGV[1]   — JSON array, one `{capacity, windowMs, cost}` per key, same order as KEYS.
 *
 * Each bucket refills continuously at `capacity / windowMs` tokens per ms up to `capacity`; a missing key is a
 * full bucket. The request is admitted only if EVERY bucket can pay its cost — then all are debited together.
 * If ANY bucket is short, NOTHING is written (deny-all, no partial consumption), so a request rejected by the
 * organisation bucket never burns the recipient's or the actor's allowance. Keys expire after one full window,
 * which is never earlier than an emptied bucket would have refilled, so expiry can never hand back a full
 * bucket too early.
 *
 * Returns `{admitted (1|0), indexOfFirstShortBucket (1-based, 0 when admitted), retryAfterMs}`.
 */
export const TOKEN_BUCKET_SCRIPT = `
local specs = cjson.decode(ARGV[1])
if #specs ~= #KEYS then return redis.error_reply('token-bucket: spec/key count mismatch') end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local levels = {}
local short = 0
local retry = 0
for i, key in ipairs(KEYS) do
  local capacity = tonumber(specs[i].capacity)
  local window = tonumber(specs[i].windowMs)
  local cost = tonumber(specs[i].cost)
  local state = redis.call('HMGET', key, 'level', 'at')
  local level = tonumber(state[1])
  local at = tonumber(state[2])
  if level == nil or at == nil then
    level = capacity
    at = now
  end
  local elapsed = now - at
  if elapsed < 0 then elapsed = 0 end
  level = math.min(capacity, level + elapsed * capacity / window)
  levels[i] = level
  if level < cost then
    if short == 0 then short = i end
    local wait = math.ceil((cost - level) * window / capacity)
    if wait > retry then retry = wait end
  end
end
if short > 0 then return {0, short, retry} end
for i, key in ipairs(KEYS) do
  redis.call('HSET', key, 'level', tostring(levels[i] - tonumber(specs[i].cost)), 'at', tostring(now))
  redis.call('PEXPIRE', key, tonumber(specs[i].windowMs))
end
return {1, 0, 0}
`;

export interface TokenBucketSpec {
  /** Logical scope, part of the key and reported back when this bucket is the one that is short. */
  scope: string;
  /** Raw identifier. Hashed (SHA-256) before it becomes part of a Redis key — no email address ever appears in Redis. */
  identifier: string;
  capacity: number;
  windowMs: number;
  cost: number;
}

export type TokenBucketDecision = { admitted: true } | { admitted: false; scope: string; retryAfterMs: number };
