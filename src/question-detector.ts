/**
 * Question detection: turns DOM observations into explicit detection events.
 *
 * Split into two halves on purpose (spec 2.4, 5.3, 7):
 *
 *  1. `QuestionChangeDecider` — pure logic. Given a stream of
 *     `QuestionSnapshot`s it decides `question-changed` / `same-question` /
 *     `pending` / `uncertain`. No DOM, no timers, fully unit tested.
 *
 *  2. `QuestionDetector` — the DOM adapter. It locates the question region
 *     using the centralized selector strategies in `site-profile.ts`, builds a
 *     snapshot, and hands it to the decider.
 *
 * Conservative-by-default rule (spec 2.4, 12 recommended defaults): when the
 * page gives us no trustworthy identity, we emit `uncertain` and keep the
 * current timer running rather than silently restarting it.
 */

import type {
  DetectionConfidence,
  DetectionEvent,
  QuestionSnapshot,
  SelectorStrategyName,
} from './types.js';
import { hashString, normalizeText } from './util.js';
import {
  FEEDBACK_SUBTREES,
  HINT_SUBTREES,
  PROGRESS_CONTAINER,
  QUESTION_REGION,
  QUESTION_STEM,
  STABLE_QUESTION_ID_ATTRS,
  ANSWER_WIDGET_MARKERS,
  progressLabel,
  readProgress,
  type SelectorStrategy,
} from './site-profile.js';

/* ================================================================== *
 * 1. Pure logic
 * ================================================================== */

/** Inputs used to build a question fingerprint from normalised strings. */
export interface FingerprintInputs {
  /** Normalised text of the question stem only (no feedback, no hints). */
  stemText: string;
  /** Structural signature of the answer widgets, e.g. "radio=4|text=0". */
  widgetSignature: string;
  /** Progress marker such as "3 of 7", when the page exposes one. */
  progress: string | null;
  /** Site-provided question id, when one is available. */
  stableId: string | null;
}

export interface QuestionIdentity {
  key: string;
  confidence: DetectionConfidence;
}

/**
 * Build the strongest available identity for a question.
 *
 * Preference order, strongest first:
 *   1. a site-provided stable id,
 *   2. a fingerprint over stem + widget shape + progress,
 *   3. the progress marker alone (weak),
 *   4. nothing usable -> caller must treat the question as unidentified.
 *
 * The progress marker is folded into the fingerprint deliberately: Khan
 * Academy can legitimately repeat similar or identical stems within one set
 * (spec 12.3), so stem text alone is not a reliable discriminator.
 */
export function buildQuestionIdentity(inputs: FingerprintInputs): QuestionIdentity | null {
  const stableId = normalizeText(inputs.stableId);
  if (stableId) return { key: `id:${stableId}`, confidence: 'stable-id' };

  const stem = normalizeText(inputs.stemText);
  const widgets = normalizeText(inputs.widgetSignature);
  const progress = normalizeText(inputs.progress);

  if (stem || widgets) {
    const source = [stem, widgets, progress].join('\u0001');
    return { key: `fp:${hashString(source)}`, confidence: 'fingerprint' };
  }
  if (progress) return { key: `prog:${progress}`, confidence: 'weak' };
  return null;
}

export interface DeciderOptions {
  /** How long a candidate must stay stable before it is accepted. */
  debounceMs: number;
  /** Minimum spacing between two accepted question changes. */
  cooldownMs: number;
}

export const DEFAULT_DECIDER_OPTIONS: DeciderOptions = {
  debounceMs: 400,
  cooldownMs: 1200,
};

/** Extract the identity key a snapshot offers, if any. */
export function identityKeyOf(snapshot: QuestionSnapshot): string | null {
  if (snapshot.stableId) return `id:${normalizeText(snapshot.stableId)}`;
  if (snapshot.fingerprint) return `fp:${snapshot.fingerprint}`;
  return null;
}

/**
 * De-bounced, duplicate-suppressing question-change decision logic.
 *
 * A change is committed only when a *different* identity has been observed
 * continuously for `debounceMs` and at least `cooldownMs` has passed since the
 * previous accepted change. This makes repeated DOM mutations, animations and
 * flapping A->B->A sequences produce zero extra switches.
 */
export class QuestionChangeDecider {
  private currentKey: string | null = null;
  private currentConfidence: DetectionConfidence = 'none';
  private candidate: { key: string; firstSeenAt: number } | null = null;
  private lastSwitchAt: number | null = null;
  private lastUncertainReason: string | null = null;

  private readonly options: DeciderOptions;

  constructor(options: Partial<DeciderOptions> = {}) {
    this.options = { ...DEFAULT_DECIDER_OPTIONS, ...options };
  }

  /** Update the de-bounce/cooldown windows (e.g. after a settings change). */
  configure(options: Partial<DeciderOptions>): void {
    Object.assign(this.options, options);
  }

  getCurrent(): { key: string; confidence: DetectionConfidence } | null {
    if (this.currentKey === null) return null;
    return { key: this.currentKey, confidence: this.currentConfidence };
  }

  getOptions(): DeciderOptions {
    return { ...this.options };
  }

  /** True while a different identity is waiting to be confirmed. */
  hasPendingCandidate(): boolean {
    return this.candidate !== null;
  }

  /** Forget all state, e.g. when the user disables the extension on a page. */
  reset(): void {
    this.currentKey = null;
    this.currentConfidence = 'none';
    this.candidate = null;
    this.lastSwitchAt = null;
    this.lastUncertainReason = null;
    this.reseedPending = false;
  }

  /**
   * Treat the next observation as a brand-new question even if it carries the
   * same identity.
   *
   * Needed because Khan Academy's "Start over" regenerates a fresh problem at
   * the same progress index (verified: the index is the identity, so a
   * regenerated question is otherwise indistinguishable). The caller invokes
   * this from the start-over control's click handler.
   */
  reseed(): void {
    this.reseedPending = true;
    this.candidate = null;
  }

  private reseedPending = false;

  observe(snapshot: QuestionSnapshot): DetectionEvent {
    if (!snapshot.regionFound) {
      this.candidate = null;
      return this.uncertain(snapshot.at, 'question region not found');
    }

    const key = identityKeyOf(snapshot);
    if (key === null) {
      this.candidate = null;
      return this.uncertain(snapshot.at, 'no stable identity signal for this question');
    }

    // An explicit reseed request (start-over) wins over everything else.
    if (this.reseedPending) {
      this.reseedPending = false;
      const from = this.currentKey;
      this.currentKey = key;
      this.currentConfidence = snapshot.confidence;
      this.candidate = null;
      this.lastSwitchAt = snapshot.at;
      this.lastUncertainReason = null;
      return { type: 'question-changed', at: snapshot.at, from, to: key, reason: 'reseeded' };
    }

    // First identification after start-up.
    if (this.currentKey === null) {
      this.currentKey = key;
      this.currentConfidence = snapshot.confidence;
      this.lastSwitchAt = snapshot.at;
      this.candidate = null;
      this.lastUncertainReason = null;
      return { type: 'question-changed', at: snapshot.at, from: null, to: key, reason: 'initial' };
    }

    if (key === this.currentKey) {
      this.candidate = null;
      this.lastUncertainReason = null;
      return { type: 'same-question', at: snapshot.at, key };
    }

    // A different identity: require it to persist before committing.
    if (this.candidate === null || this.candidate.key !== key) {
      this.candidate = { key, firstSeenAt: snapshot.at };
      return { type: 'pending', at: snapshot.at, candidate: key };
    }

    const stableFor = snapshot.at - this.candidate.firstSeenAt;
    const sinceSwitch =
      this.lastSwitchAt === null ? Number.POSITIVE_INFINITY : snapshot.at - this.lastSwitchAt;
    if (stableFor < this.options.debounceMs || sinceSwitch < this.options.cooldownMs) {
      return { type: 'pending', at: snapshot.at, candidate: key };
    }

    const from = this.currentKey;
    this.currentKey = key;
    this.currentConfidence = snapshot.confidence;
    this.candidate = null;
    this.lastSwitchAt = snapshot.at;
    this.lastUncertainReason = null;
    return { type: 'question-changed', at: snapshot.at, from, to: key, reason: 'stable-change' };
  }

  /**
   * Commit an identity immediately, bypassing de-bounce. Used for signals that
   * are unambiguous on their own — an explicit URL change, or the learner
   * using the page's own previous/next navigation.
   */
  forceSwitch(key: string, at: number, reason: string): DetectionEvent {
    if (key === this.currentKey) {
      this.candidate = null;
      return { type: 'same-question', at, key };
    }
    const from = this.currentKey;
    this.currentKey = key;
    this.currentConfidence = 'stable-id';
    this.candidate = null;
    this.lastSwitchAt = at;
    this.lastUncertainReason = null;
    return { type: 'question-changed', at, from, to: key, reason };
  }

  private uncertain(at: number, reason: string): DetectionEvent {
    // Collapse repeats so the UI is not spammed with identical warnings.
    if (this.lastUncertainReason === reason) {
      return { type: 'uncertain', at, reason };
    }
    this.lastUncertainReason = reason;
    return { type: 'uncertain', at, reason };
  }
}

/* ================================================================== *
 * 2. DOM adapter
 * ================================================================== */

export interface DetectorCallbacks {
  onEvent: (event: DetectionEvent, snapshot: QuestionSnapshot) => void;
  onDiagnostics?: (info: DetectorDiagnostics) => void;
}

export interface DetectorDiagnostics {
  regionFound: boolean;
  strategy: SelectorStrategyName | null;
  confidence: DetectionConfidence;
  questionKey: string | null;
  progress: string | null;
  progressRaw: string | null;
  evaluateCount: number;
  lastEvaluateAt: number;
  lastReason: string;
  /** True once the detector has been stopped; evaluation is then a no-op. */
  stopped: boolean;
  /** How many times the poll interval has run. */
  pollTicks: number;
  /** How many times a MutationObserver callback has fired. */
  mutationCallbacks: number;
  /** A different question identity is waiting to be confirmed. */
  pendingCandidate: boolean;
  regionConnected: boolean;
  progressContainerConnected: boolean;
  hasRegionObserver: boolean;
  hasProgressObserver: boolean;
  hasBodyObserver: boolean;
  pollTimerActive: boolean;
  notes: string[];
  errors: string[];
}

/** The element our own overlay is mounted in; never treated as page content. */
export const OVERLAY_HOST_ID = 'khan-academy-timer-host';

/** How often the page is re-checked for navigation and region identity. */
const POLL_INTERVAL_MS = 700;
/** Minimum spacing between fingerprint recomputations triggered by mutations. */
const EVALUATE_THROTTLE_MS = 200;
/** Minimum spacing between diagnostics emissions to the popup and the page. */
const DIAGNOSTICS_INTERVAL_MS = 1000;

function tryStrategies(
  strategies: SelectorStrategy[],
  root: ParentNode,
  notes: string[],
  errors: string[],
  role: string,
): { element: Element | null; strategy: string | null } {
  for (const strategy of strategies) {
    let found: Element | null = null;
    try {
      found = strategy.select(root);
    } catch (error) {
      errors.push(`${role}/${strategy.name}: ${(error as Error).message}`);
      continue;
    }
    if (found) {
      notes.push(`${role}: matched "${strategy.name}"`);
      return { element: found, strategy: strategy.name };
    }
  }
  errors.push(`${role}: no strategy matched (tried ${strategies.length})`);
  return { element: null, strategy: null };
}

/** Remove feedback/hint/explanation subtrees from a clone before hashing. */
function stemTextOf(region: Element): string {
  const clone = region.cloneNode(true) as Element;
  for (const selector of [...FEEDBACK_SUBTREES, ...HINT_SUBTREES]) {
    try {
      for (const node of Array.from(clone.querySelectorAll(selector))) node.remove();
    } catch {
      /* an invalid selector must never break detection */
    }
  }
  // Prefer a dedicated stem node when the profile can find one.
  for (const strategy of QUESTION_STEM) {
    try {
      const stem = strategy.select(clone);
      if (stem) return normalizeText(stem.textContent);
    } catch {
      /* keep falling back */
    }
  }
  return normalizeText(clone.textContent);
}

/** Shape of the answer controls, e.g. "radio=4|text=1". */
function widgetSignatureOf(region: Element): string {
  const parts: string[] = [];
  for (const marker of ANSWER_WIDGET_MARKERS) {
    let count = 0;
    try {
      count = region.querySelectorAll(marker.selector).length;
    } catch {
      count = 0;
    }
    if (count > 0) parts.push(`${marker.name}=${count}`);
  }
  return parts.join('|');
}

/**
 * A site-provided, stable per-question identifier, if the page exposes one.
 *
 * [VER] Khan Academy's exercise page exposes none of these (see
 * `STABLE_QUESTION_ID_ATTRS`), so this normally returns null and the verified
 * progress-index identity is used instead.
 */
function stableIdOf(region: Element): string | null {
  for (const attr of STABLE_QUESTION_ID_ATTRS) {
    const value = region.getAttribute(attr) ?? region.closest(`[${attr}]`)?.getAttribute(attr);
    if (value) return value;
  }
  return null;
}

/**
 * Watches the page and reports question changes.
 *
 * DOM queries are confined to the located question region (spec 5.3). A single
 * coarse body observer is used only to notice when the region element gets
 * replaced by the SPA.
 */
export class QuestionDetector {
  private readonly decider: QuestionChangeDecider;
  private readonly callbacks: DetectorCallbacks;
  private region: Element | null = null;
  private regionObserver: MutationObserver | null = null;
  private progressObserver: MutationObserver | null = null;
  private bodyObserver: MutationObserver | null = null;
  private pollTimer: number | null = null;
  private throttleTimer: number | null = null;
  private lastEvaluateAt = 0;
  private lastUrl = '';
  private lastDiagnosticsAt = 0;
  private stopped = true;

  constructor(callbacks: DetectorCallbacks, deciderOptions: Partial<DeciderOptions> = {}) {
    this.callbacks = callbacks;
    this.decider = new QuestionChangeDecider(deciderOptions);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastUrl = location.href;
    this.attachRegion();
    // The SPA can swap the whole question container; watch the body coarsely
    // so we can re-resolve the region when ours is detached.
    this.bodyObserver = new MutationObserver(() => {
      if (!this.region || !this.region.isConnected) this.attachRegion();
    });
    this.bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.pollTimer = window.setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.evaluate('start');
  }

  stop(): void {
    this.stopped = true;
    this.regionObserver?.disconnect();
    this.progressObserver?.disconnect();
    this.bodyObserver?.disconnect();
    this.regionObserver = null;
    this.progressObserver = null;
    this.bodyObserver = null;
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.throttleTimer !== null) window.clearTimeout(this.throttleTimer);
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    this.pollTimer = null;
    this.throttleTimer = null;
    this.pendingTimer = null;
    this.region = null;
    this.progressContainer = null;
    this.emitDiagnostics(true, 'stop');
  }

  configure(options: Partial<DeciderOptions>): void {
    this.decider.configure(options);
  }

  /** Force an immediate re-evaluation, e.g. after the user clicks "reset". */
  reevaluate(reason: string): void {
    this.evaluate(reason);
  }

  /**
   * Mark that the current question was regenerated in place (Khan Academy's
   * "Start over"), so the next observation starts a fresh timer.
   */
  reseed(reason = 'start-over'): void {
    this.decider.reseed();
    this.evaluate(reason);
  }

  getCurrentKey(): string | null {
    return this.decider.getCurrent()?.key ?? null;
  }

  /* ---------------- internals ---------------- */

  private attachRegion(): void {
    const notes: string[] = [];
    const errors: string[] = [];
    const { element, strategy } = tryStrategies(
      QUESTION_REGION,
      document,
      notes,
      errors,
      'questionRegion',
    );

    // The region observer is bound to whatever `QUESTION_REGION` currently
    // matches. It is only rebound when the matched node actually changes, so a
    // stable region does not churn observers on every poll.
    if (element !== this.region) {
      this.regionObserver?.disconnect();
      this.regionObserver = null;
      this.region = element;
      if (element) {
        this.regionObserver = new MutationObserver(() => this.scheduleEvaluate());
        this.regionObserver.observe(element, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'data-testid', 'aria-checked', 'aria-valuenow', 'value'],
        });
      }
    }
    this.pendingStrategy = strategy;

    // The progress marker lives outside the question region, so its container
    // is watched separately. This is what makes a real question advance show up
    // immediately instead of waiting for the next poll (spec 2.2).
    //
    // NOTE: this must be re-evaluated on *every* attach, independently of
    // whether the region changed. An earlier version returned early when the
    // region was unchanged, which left this observer bound to a detached footer
    // node after the SPA replaced it - and question advances then went
    // completely unnoticed. Caught by scripts/verify-extension.mjs.
    const progressContainer = tryStrategies(
      PROGRESS_CONTAINER,
      document,
      [],
      [],
      'progressContainer',
    ).element;
    if (progressContainer !== this.progressContainer) {
      this.progressObserver?.disconnect();
      this.progressObserver = null;
      this.progressContainer = progressContainer;
    }
    if (this.progressContainer && !this.progressObserver) {
      this.progressObserver = new MutationObserver(() => this.scheduleEvaluate());
      this.progressObserver.observe(this.progressContainer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-testid', 'aria-label', 'class'],
      });
    }
  }

  private pendingStrategy: SelectorStrategyName | null = null;

  /** Navigation-ish polling: cheap, and immune to SPA history quirks. */
  private poll(): void {
    this.pollTicks += 1;
    if (this.stopped) return;
    if (location.href !== this.lastUrl) {
      this.lastUrl = location.href;
      // A hard navigation to a different page invalidates all detection state.
      this.decider.reset();
      this.attachRegion();
      this.evaluate('url-change');
      return;
    }
    if (!this.region || !this.region.isConnected) {
      this.attachRegion();
      this.evaluate('region-reattached');
      return;
    }
    // The SPA can also replace the footer that holds the progress marker.
    if (this.progressContainer && !this.progressContainer.isConnected) {
      this.attachRegion();
      this.evaluate('progress-container-reattached');
      return;
    }
    // Fallback confirmer: if a candidate change is still waiting, look again.
    // This is belt-and-braces next to `armPendingConfirmation`, and it also
    // keeps the diagnostics counters truthful while nothing else is happening.
    if (this.decider.hasPendingCandidate()) {
      this.evaluate('pending-candidate');
      return;
    }
    this.emitDiagnostics(false, 'poll');
  }

  private progressContainer: Element | null = null;

  private scheduleEvaluate(): void {
    this.mutationCallbacks += 1;
    if (this.stopped) return;
    const now = Date.now();
    const elapsed = now - this.lastEvaluateAt;
    if (elapsed >= EVALUATE_THROTTLE_MS) {
      this.evaluate('mutation');
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = window.setTimeout(() => {
      this.throttleTimer = null;
      this.evaluate('mutation-throttled');
    }, EVALUATE_THROTTLE_MS - elapsed);
  }

  private buildSnapshot(): QuestionSnapshot {
    const at = Date.now();
    const notes: string[] = [];
    const errors: string[] = [];
    const region = this.region;

    if (!region || !region.isConnected) {
      this.lastNotes = [];
      this.lastErrors = ['questionRegion: no strategy matched'];
      return {
        at,
        stableId: null,
        fingerprint: null,
        progress: null,
        url: location.href,
        regionFound: false,
        strategy: null,
        confidence: 'none',
      };
    }

    // Question identity, in verified order of strength.
    //
    // 1. A per-question id attribute, if this page type happens to expose one.
    // 2. The progress marker's INDEX, e.g. "3 of 7". Observation proved this
    //    moves exactly when the exercise advances, and does NOT move when an
    //    answer is submitted or when hints/solutions expand. Using it as the
    //    identity therefore makes auxiliary content harmless by construction.
    // 3. A stem fingerprint, used only when no progress marker exists. That is
    //    an unverified page type, so the overlay reports reduced confidence.
    const progressInfo = readProgress(document);
    const progress = progressLabel(progressInfo);
    notes.push(
      progressInfo
        ? `progress: index ${progressInfo.index + 1}/${progressInfo.total ?? '?'} state=${progressInfo.state}`
        : 'progress: no exercise-progress-* marker found',
    );

    const widgetSignature = widgetSignatureOf(region);
    const stemText = stemTextOf(region);
    const attributeId = stableIdOf(region);
    const progressId = progress === null ? null : `progress:${progress}`;
    const identity = buildQuestionIdentity({
      stemText,
      widgetSignature,
      progress,
      stableId: attributeId ?? progressId,
    });

    this.lastNotes = notes;
    this.lastErrors = errors;
    this.lastProgressRaw = progressInfo?.raw ?? null;
    return {
      at,
      stableId: identity?.confidence === 'stable-id' ? (attributeId ?? progressId) : null,
      fingerprint: identity && identity.confidence !== 'stable-id' ? identity.key.slice(3) : null,
      progress,
      url: location.href,
      regionFound: true,
      strategy: this.pendingStrategy,
      confidence: identity?.confidence ?? 'none',
    };
  }

  private lastNotes: string[] = [];
  private lastErrors: string[] = [];
  private lastProgressRaw: string | null = null;
  private lastSnapshot: QuestionSnapshot | null = null;
  private pollTicks = 0;
  private mutationCallbacks = 0;
  private evaluateCount = 0;
  private lastEvaluateAtMs = 0;
  private lastReason = 'none';
  private pendingTimer: number | null = null;

  private evaluate(reason: string): void {
    if (this.stopped) return;
    this.lastEvaluateAt = Date.now();
    this.evaluateCount += 1;
    this.lastEvaluateAtMs = this.lastEvaluateAt;
    this.lastReason = reason;
    const snapshot = this.buildSnapshot();
    this.lastSnapshot = snapshot;
    const event = this.decider.observe(snapshot);
    this.callbacks.onEvent(event, snapshot);
    this.armPendingConfirmation(event);
    this.emitDiagnostics(true, `evaluate: ${reason}`);
  }

  /**
   * A de-bounced switch needs to be observed a *second* time once the
   * de-bounce window has elapsed. The mutation that revealed the new question
   * has already been consumed by the time the window closes, so without an
   * explicit follow-up the candidate would sit unconfirmed forever and the
   * change would never be committed.
   *
   * Found by scripts/verify-extension.mjs: the panel reported
   * "检测到可能的题目变化，等待确认…" and then stayed there indefinitely while the
   * old question's timer kept running.
   */
  private armPendingConfirmation(event: DetectionEvent): void {
    if (this.pendingTimer !== null) {
      window.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (event.type !== 'pending') return;
    const { debounceMs } = this.decider.getOptions();
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = null;
      this.evaluate('pending-confirm');
    }, Math.max(50, debounceMs) + 60);
  }

  /**
   * Emit a diagnostics snapshot. `force` bypasses the once-per-second throttle,
   * which keeps a stalled detector visible instead of replaying stale counters.
   */
  private emitDiagnostics(force: boolean, note: string): void {
    if (!this.callbacks.onDiagnostics) return;
    const now = Date.now();
    if (!force && now - this.lastDiagnosticsAt <= DIAGNOSTICS_INTERVAL_MS) return;
    this.lastDiagnosticsAt = now;
    this.callbacks.onDiagnostics({
      regionFound: this.region ? this.region.isConnected : false,
      strategy: this.lastSnapshot?.strategy ?? this.pendingStrategy,
      confidence: this.lastSnapshot?.confidence ?? 'none',
      questionKey: this.decider.getCurrent()?.key ?? null,
      progress: this.lastSnapshot?.progress ?? null,
      progressRaw: this.lastProgressRaw,
      evaluateCount: this.evaluateCount,
      lastEvaluateAt: this.lastEvaluateAtMs,
      lastReason: this.lastReason,
      stopped: this.stopped,
      pollTicks: this.pollTicks,
      mutationCallbacks: this.mutationCallbacks,
      regionConnected: this.region ? this.region.isConnected : false,
      progressContainerConnected: this.progressContainer
        ? this.progressContainer.isConnected
        : false,
      hasRegionObserver: this.regionObserver !== null,
      hasProgressObserver: this.progressObserver !== null,
      hasBodyObserver: this.bodyObserver !== null,
      pollTimerActive: this.pollTimer !== null,
      pendingCandidate: this.decider.hasPendingCandidate(),
      notes: [...this.lastNotes, note],
      errors: [...this.lastErrors],
    });
  }

  /**
   * Refresh diagnostics without re-running detection. Called on a slow cadence
   * by the controller so the panel's support attribute stays truthful.
   */
  refreshDiagnostics(): void {
    this.emitDiagnostics(false, 'refresh');
  }

  /** Force a diagnostics emission even if the throttle window has not elapsed. */
  flushDiagnostics(reason: string): void {
    this.lastDiagnosticsAt = 0;
    this.evaluate(reason);
  }
}
