/**
 * Countdown expiry tone.
 *
 * Generated with the Web Audio API rather than shipping an audio file: no
 * network fetch, no extra extension resource, and nothing to keep in sync with
 * the manifest (spec 6 and 3.9 — no code or assets downloaded at runtime).
 *
 * Browsers block audio until the page has seen a user gesture. If the context
 * cannot start we simply stay silent and report it, rather than throwing.
 */

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (context) return context;
  const Ctor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/**
 * Play a short two-beep expiry tone.
 * Returns true when a tone was actually scheduled.
 */
export function playExpiryTone(): boolean {
  const ctx = getContext();
  if (!ctx) return false;
  try {
    // A suspended context needs a user gesture; try anyway, ignore failure.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime;
    for (let i = 0; i < 2; i += 1) {
      const at = start + i * 0.28;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.24);
    }
    return true;
  } catch {
    return false;
  }
}

/** Release the audio context, e.g. when the content script is torn down. */
export function disposeAudio(): void {
  try {
    void context?.close();
  } catch {
    /* nothing useful to do */
  }
  context = null;
}
