/**
 * Small dependency-free helpers shared across modules.
 *
 * Kept separate from `timer-engine.ts` so the engine stays purely about timing
 * and so the hashing used for question fingerprints is testable on its own.
 */

/**
 * FNV-1a 32-bit hash rendered as 8 hex characters.
 *
 * Used only to turn a normalised question fingerprint string into a short
 * stable key. It is a *local* identifier: nothing is sent anywhere, and the
 * full question text is never persisted (spec 6).
 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, with 32-bit overflow semantics.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Collapse whitespace and trim, so cosmetic markup changes do not matter. */
export function normalizeText(input: string | null | undefined): string {
  return (input ?? '').replace(/\s+/g, ' ').trim();
}

/** Locally generated unique id for a record. */
export function uniqueId(prefix = 'r'): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return `${prefix}_${globalCrypto.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/** Clamp a possibly-untrusted number from storage into a sane range. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse a stored boolean, accepting the stringy forms storage may hold. */
export function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Narrow an unknown value to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Milliseconds from seconds, clamped to a sane per-question range. */
export function secondsToMs(seconds: number, min = 5, max = 3600): number {
  return Math.round(clampNumber(seconds, min, max, 60) * 1000);
}
