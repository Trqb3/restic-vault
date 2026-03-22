import crypto from 'crypto';
import bcrypt from 'bcrypt';

// ── Token format: rvs1_<timestamp_base36>_<48_hex_chars> ─────────────────────
// Example: rvs1_lf8k2z_a3d9f1b2c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7

/** Generate a new raw token and its bcrypt hash. */
export async function generateToken(): Promise<{ raw: string; hash: string }> {
  const timestamp  = Date.now().toString(36);
  const randomPart = crypto.randomBytes(24).toString('hex');  // 48 hex chars
  const raw        = `rvs1_${timestamp}_${randomPart}`;
  const hash       = await bcrypt.hash(raw, 10);
  return { raw, hash };
}

/** Verify a raw token against a bcrypt hash. */
export async function verifyToken(raw: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(raw, hash);
  } catch {
    return false;
  }
}

// ── In-memory token auth cache ────────────────────────────────────────────────
// Caches sourceId for a raw token for 10 minutes to avoid bcrypt on every restic
// HTTP request (there can be hundreds per backup run).

const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  sourceId: number;
  disabled: boolean;
  expiresAt: number;
}

const authCache = new Map<string, CacheEntry>();

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authCache) {
    if (entry.expiresAt < now) authCache.delete(key);
  }
}, 5 * 60 * 1000).unref();

export function cacheAuthResult(rawToken: string, sourceId: number, disabled: boolean): void {
  authCache.set(rawToken, { sourceId, disabled, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function getCachedAuth(rawToken: string): CacheEntry | undefined {
  const entry = authCache.get(rawToken);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    authCache.delete(rawToken);
    return undefined;
  }
  return entry;
}

export function evictFromCache(rawToken: string): void {
  authCache.delete(rawToken);
}

export function evictSourceFromCache(sourceId: number): void {
  for (const [key, entry] of authCache) {
    if (entry.sourceId === sourceId) authCache.delete(key);
  }
}
