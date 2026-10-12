/**
 * Shared type definitions for Khan Academy Timer.
 *
 * Design rule (spec 5.3 / 7): the timer engine and the question-change decision
 * logic are pure TypeScript with no DOM and no `chrome.*` access, so that they
 * can be unit tested deterministically. DOM and extension APIs live behind
 * adapters in `question-detector.ts`, `overlay.ts`, `storage.ts`.
 */

/* ------------------------------------------------------------------ *
 * Timer
 * ------------------------------------------------------------------ */

/** Counting up (stopwatch) or down (limited time per question). */
export type TimerMode = 'countup' | 'countdown';

/**
 * Lifecycle phase of a single question's timer.
 *
 * `expired` is deliberately NOT a phase: a countdown that hits zero keeps
 * counting up (so the panel can show how far over time the learner is) while
 * an orthogonal `expired` flag drives the timeout styling and the beep.
 */
export type TimerPhase = 'idle' | 'running' | 'paused' | 'finished';

/**
 * Why a question's timing session ended.
 *
 * `answered-correct` and `skipped` are "the learner finished with this
 * question" reasons: timing stops immediately at that moment, while the
 * question is still on screen. The record is written later, when the question
 * actually changes or the end-of-exercise summary appears.
 */
export type EndReason =
  | 'answered-correct'
  | 'skipped'
  | 'question-change'
  | 'exercise-complete'
  | 'navigation'
  | 'page-unload'
  | 'manual-reset'
  | 'abandoned';

/** Outcome of the learner's first answer submission for a question. */
export type FirstSubmissionOutcome = 'correct' | 'incorrect' | 'unknown';

/** Storage status of a record, per spec 2.5 ("record status"). */
export type RecordStatus = 'completed' | 'expired' | 'partial' | 'skipped';

/** How confidently the question identity was established. */
export type DetectionConfidence = 'stable-id' | 'fingerprint' | 'weak' | 'none';

/** Immutable snapshot of a timer, safe to render or persist. */
export interface TimerSnapshot {
  mode: TimerMode;
  phase: TimerPhase;
  /** Wall clock instant the question timer first started, or null while idle. */
  startedAt: number | null;
  /** Running time excluding paused stretches. */
  elapsedMs: number;
  /** Total time spent paused. */
  pausedMs: number;
  /** Configured limit for countdown mode; null for countup mode. */
  limitMs: number | null;
  /** Countdown time left, clamped at zero; null in countup mode. */
  remainingMs: number | null;
  /** True once elapsedMs has reached limitMs (countdown only). */
  expired: boolean;
  /**
   * Exact wall-clock instant at which the countdown reached zero, computed
   * from timestamps rather than from when a tick happened to run. Null when
   * the timer has not expired.
   */
  expiredAt: number | null;
  /** How long past the limit the timer is; 0 when not expired. */
  overrunMs: number;
}

/** Serializable form of a running session, used to survive page reloads. */
export interface TimerSerialized {
  version: 1;
  mode: TimerMode;
  phase: TimerPhase;
  questionKey: string;
  /**
   * Stem-and-widget hash of the question, so a resumed session can still be
   * matched when the page identifies the question by fingerprint first and only
   * reports its progress position a moment later.
   */
  stemFingerprint: string | null;
  exerciseKey: string;
  startedAt: number;
  accumulatedMs: number;
  pausedMs: number;
  limitMs: number | null;
  expiredAt: number | null;
  firstSubmissionAt: number | null;
  firstSubmissionOutcome: FirstSubmissionOutcome | null;
  /** Wall clock of the last checkpoint write, for diagnostics. */
  savedAt: number;
}

/* ------------------------------------------------------------------ *
 * Question detection
 * ------------------------------------------------------------------ */

/** Which selector strategy produced the question region. */
export type SelectorStrategyName = string;

/** Raw, DOM-derived observations about the current question. */
export interface QuestionSnapshot {
  /** Observation timestamp (epoch ms). */
  at: number;
  /**
   * Strongest available identity: a site-provided question id or a
   * navigation/position signal. Null when none is trustworthy.
   */
  stableId: string | null;
  /** Hash over the question stem and answer-widget shape. Null if unavailable. */
  fingerprint: string | null;
  /**
   * Hash over the stem and answer-widget shape ONLY (no progress position),
   * computed on every observation.
   *
   * It exists so a question can be recognised as the SAME question across an
   * identity upgrade: on a real page load the question region appears before the
   * progress marker does, so the first identity is a fingerprint and it becomes
   * a progress id a moment later. Without this field that upgrade looks like a
   * question change - which restarted the timer at zero and lost the time
   * already spent (reproduced on khanacademy.org, see
   * scripts/verify-practice-switch.mjs).
   */
  stemFingerprint: string | null;
  /** Human-readable progress marker, e.g. "3 of 7". Diagnostics and grouping. */
  progress: string | null;
  /** Page URL at observation time. */
  url: string;
  /** True when a question region was actually located in the DOM. */
  regionFound: boolean;
  /** Which selector strategy matched, for the diagnostics panel. */
  strategy: SelectorStrategyName | null;
  /** Confidence implied by the signals above. */
  confidence: DetectionConfidence;
}

/** Events emitted by the question detector. */
export type DetectionEvent =
  | { type: 'question-changed'; at: number; from: string | null; to: string; reason: string }
  | { type: 'same-question'; at: number; key: string }
  /**
   * The same question, now identified more strongly (fingerprint -> progress
   * id). The timer must keep running and only its identity is updated.
   */
  | { type: 'identity-upgraded'; at: number; from: string; to: string }
  | { type: 'pending'; at: number; candidate: string }
  | { type: 'uncertain'; at: number; reason: string };

/* ------------------------------------------------------------------ *
 * Records and settings
 * ------------------------------------------------------------------ */

/**
 * A language the extension ships a message catalog for (see `src/i18n/`).
 *
 * These are BCP-47 tags, so they can be handed straight to `Intl`/`toLocale*`.
 */
export type Locale = 'en' | 'zh-CN';

/**
 * The stored language setting.
 *
 * `auto` follows the browser UI language; any other value forces that catalog,
 * which is what makes the English UI testable without reconfiguring the browser.
 * English (`FALLBACK_LOCALE`) is used for a language we do not ship and for any
 * individual message a translation is missing.
 */
export type LanguageSetting = 'auto' | Locale;

/** One saved timing record. Contains no answer content (spec 2.5 / 6). */
export interface QuestionRecord {
  /** Locally generated unique id. */
  id: string;
  /** Local question fingerprint or site-provided id. */
  questionKey: string;
  /** Page/exercise identity, e.g. "e/addition_1". */
  exerciseKey: string;
  /** Wall clock the question timer started. */
  startedAt: number;
  /** Wall clock the record was closed. */
  endedAt: number;
  /** Running time excluding pauses. */
  durationMs: number;
  /** Total paused time. */
  pausedMs: number;
  mode: TimerMode;
  /** Configured limit in ms, countdown mode only. */
  limitMs: number | null;
  /** True if the countdown reached zero. */
  timedOut: boolean;
  /** Wall clock of the first answer submission, or null (spec 2.4). */
  firstSubmissionAt: number | null;
  firstSubmissionOutcome: FirstSubmissionOutcome | null;
  endReason: EndReason;
  status: RecordStatus;
  detectionConfidence: DetectionConfidence;
  /** Manually paused by the user at some point during the question. */
  wasPaused: boolean;
  /**
   * One pass through an exercise. Groups the records shown on the
   * end-of-exercise summary, so "this round" is distinguishable from an
   * earlier attempt at the same exercise.
   */
  runId: string;
  /** Zero-based position of the question within the exercise, when known. */
  questionIndex: number | null;
  /** Number of questions in the exercise, when the page exposes it. */
  questionTotal: number | null;
}

/**
 * The exercise attempt currently in progress.
 *
 * Persisted under `run:<exerciseKey>` rather than inside the per-question
 * session, because the session is replaced on every question change.
 */
export interface ActiveRun {
  version: 1;
  runId: string;
  exerciseKey: string;
  startedAt: number;
  /** Set once the end-of-exercise summary has been shown for this run. */
  summarizedAt: number | null;
  /** Highest question index seen, for diagnostics. */
  lastQuestionIndex: number | null;
}

/** One row of the end-of-exercise summary panel. */
export interface SummaryRow {
  /**
   * The question's own number within the exercise (1-based), i.e. the page's
   * progress index + 1.
   *
   * Numbered by the question the row is about, NOT by the order the records
   * happened to be captured: after a detour through another practice, or after
   * a question whose timing was lost, capture order and question order disagree,
   * and numbering by capture order would print one question's time under
   * another question's number. Null only for a record the page gave no position
   * for (an unnumbered bonus question).
   */
  questionNumber: number | null;
  /**
   * True when the exercise has a question with this number but no timing data
   * for it (it was never timed, or its record was lost). The card prints
   * "No data" instead of silently moving the next question up.
   */
  missing?: boolean;
  /**
   * True when this row is the optional bonus question, detected by the page's
   * own index moving backwards within the run. Bonus rows are appended after
   * the numbered questions so a re-used index never repeats a number.
   */
  bonus: boolean;
  durationMs: number;
  pausedMs: number;
  mode: TimerMode;
  limitMs: number | null;
  timedOut: boolean;
  skipped: boolean;
  firstSubmissionOutcome: FirstSubmissionOutcome | null;
  endReason: EndReason;
}

/** Overlay anchor mode. */
export type OverlayAnchor = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'custom';

export interface OverlayPosition {
  anchor: OverlayAnchor;
  /** Offset in CSS pixels from the anchored corner (custom: from top-left). */
  x: number;
  y: number;
}

/** User settings, persisted in `chrome.storage.local` (spec 2.5). */
export interface Settings {
  /**
   * Language of every label the extension renders: the in-page panel, the
   * end-of-exercise card and the popup. `auto` follows the browser UI language.
   */
  language: LanguageSetting;
  /** Timer mode used for newly detected questions. */
  defaultMode: TimerMode;
  /** Time limit per question in seconds, countdown mode. */
  countdownLimitSeconds: number;
  /** Play a short tone when the countdown reaches zero. */
  soundEnabled: boolean;
  /** Show the in-page overlay panel. */
  overlayVisible: boolean;
  /** Overlay starts collapsed to a compact pill. */
  overlayCollapsed: boolean;
  /**
   * Show the detection internals in the popup: selector strategy, confidence,
   * question key/fingerprint, the last detector event and the raw diagnostics
   * block. Off by default so the popup stays readable for a normal learner;
   * the question progress row is shown either way.
   */
  developerMode: boolean;
  /**
   * The end-of-exercise "per-question times" card starts collapsed to its
   * header line. Remembered so the learner does not have to fold it every time.
   */
  summaryCollapsed: boolean;
  overlayPosition: OverlayPosition;
  /**
   * When true, closing the page freezes the question clock and reopening the
   * same question resumes from the saved elapsed time (spec 2.2).
   */
  resumeAcrossReload: boolean;
  /**
   * Time a candidate question identity must remain stable before it is
   * accepted as a real question change (spec 2.4 de-bounce).
   */
  detectionDebounceMs: number;
  /** Minimum spacing between accepted question changes. */
  detectionCooldownMs: number;
}

export interface StoredRecords {
  version: 1;
  /** Newest last. Capped at MAX_RECORDS in `storage.ts`. */
  records: QuestionRecord[];
}

/** Diagnostics surfaced to the popup so failures are visible, not silent. */
export interface Diagnostics {
  url: string;
  exerciseKey: string;
  detected: boolean;
  strategy: SelectorStrategyName | null;
  confidence: DetectionConfidence;
  questionKey: string | null;
  progress: string | null;
  /** Raw progress testid, e.g. "exercise-progress-1-incomplete-current". */
  progressRaw: string | null;
  /** How many times the detector has evaluated the page this session. */
  evaluateCount: number;
  /** Wall clock of the most recent evaluation. */
  lastEvaluateAt: number;
  /** Why the most recent evaluation was triggered. */
  lastReason: string;
  /** Human-readable list of what the adapter tried. */
  notes: string[];
  lastEvent: string;
  /** Regressions seen: selector strategies that failed to match. */
  errors: string[];
}
