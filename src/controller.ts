/**
 * Coordinator: owns the single active question timer for the page.
 *
 * Responsibilities (spec 2.2, 2.3, 5.3):
 *  - own the single active `TimerEngine` for the current question,
 *  - translate detection events into timer transitions and saved records,
 *  - drive the overlay render loop from timestamps (never from tick counts),
 *  - checkpoint the in-flight session so closing the page does not lose data,
 *  - apply settings changes arriving from the popup,
 *  - answer popup queries with live status and detection diagnostics.
 *
 * Write policy: storage is written on *state changes* (start, pause, resume,
 * reset, question change) and at most once per `CHECKPOINT_INTERVAL_MS` while
 * running — never once per DOM mutation (spec 5.3).
 */

import {
  OVERLAY_HOST_ID,
  QuestionDetector,
  identityKeyOf,
  isPositionedQuestionKey,
  type DetectorDiagnostics,
  type ProgressStateChange,
} from './question-detector.js';
import { OverlayView, type OverlayState } from './overlay.js';
import { SummaryView, buildSummaryRows } from './summary-view.js';
import { TimerEngine, formatDuration } from './timer-engine.js';
import { render, setLocale, type MessageRef } from './i18n/index.js';
import { disposeAudio, playExpiryTone } from './sound.js';
import {
  chromeStorageArea,
  createRecordQueue,
  ensureAttemptWindow,
  loadAttemptWindow,
  markAttemptSummarized,
  clearRun,
  clearSession,
  loadRecords,
  loadRun,
  loadSession,
  loadSettings,
  parkedSession,
  pruneSessions,
  attemptRecordsFor,
  sanitizeSettings,
  saveRun,
  saveSession,
  saveSettings,
  type RecordQueue,
  type StorageArea,
} from './storage.js';
import {
  CORRECT_INDICATORS,
  INCORRECT_INDICATORS,
  SKIP_BUTTON,
  START_OVER_BUTTON,
  SUBMIT_BUTTON,
  SUMMARY_HOST,
  completionTriggerFor,
  exerciseKeyFromUrl,
  isQuestionFinished,
  isStartCardPresent,
  isSummaryPage,
  readProgress,
  shouldLeaveSummary,
  readSubmissionOutcome,
} from './site-profile.js';
import type {
  ActiveRun,
  DetectionConfidence,
  DetectionEvent,
  EndReason,
  FirstSubmissionOutcome,
  QuestionRecord,
  QuestionSnapshot,
  Settings,
  SummaryRow,
  TimerSnapshot,
} from './types.js';
import { secondsToMs, uniqueId } from './util.js';

/** How often the overlay display is refreshed. Values come from timestamps. */
const TICK_INTERVAL_MS = 250;
/** Upper bound on how often a running session is written to storage. */
const CHECKPOINT_INTERVAL_MS = 5000;
/** Sessions shorter than this are treated as detection noise, not records. */
const MIN_RECORD_MS = 1000;
/** Delay before reading the feedback area to decide correct/incorrect. */
const FEEDBACK_SETTLE_MS = 350;
/** How often to look for the end-of-exercise summary screen. */
const SUMMARY_CHECK_INTERVAL_MS = 700;

export class ContentController {
  private area: StorageArea | null = null;
  private settings!: Settings;
  private engine: TimerEngine | null = null;
  private detector: QuestionDetector | null = null;
  private overlay: OverlayView | null = null;

  private recordsCount = 0;
  private tickTimer: number | null = null;
  private lastCheckpointAt = 0;
  /**
   * What the panel's footer says about the last thing the detector did.
   *
   * Held as a message reference rather than as a finished string, and rendered
   * whenever it is displayed: this text sits on screen for a long time, so a
   * learner who changes the language in the popup must not be left reading the
   * previous one until the next event happens to replace it.
   */
  private lastEvent: MessageRef = { key: 'event.initializing' };
  /** Non-null while detection is degraded; see `warningText`. */
  private warning: MessageRef | null = null;
  private diagnostics: DetectorDiagnostics = {
    regionFound: false,
    strategy: null,
    confidence: 'none',
    questionKey: null,
    progress: null,
    progressRaw: null,
    evaluateCount: 0,
    lastEvaluateAt: 0,
    lastReason: 'init',
    stopped: false,
    pollTicks: 0,
    mutationCallbacks: 0,
    regionConnected: false,
    progressContainerConnected: false,
    hasRegionObserver: false,
    hasProgressObserver: false,
    hasBodyObserver: false,
    pollTimerActive: false,
    pendingCandidate: false,
    notes: [],
    errors: [],
  };
  private currentExerciseKey = '';
  private currentConfidence: DetectionConfidence = 'none';
  /** Guards async flows against interleaving detection events. */
  private flowToken = 0;
  private submissionListenerInstalled = false;
  private started = false;
  private disposed = false;
  private tickCount = 0;

  /** Serialised writer for the saved timing records. */
  private recordQueue: RecordQueue = createRecordQueue(null);
  /** The run (one pass through the exercise) that records are tagged with. */
  private run: ActiveRun | null = null;
  /**
   * A completed question whose record has not been written yet. Timing stopped
   * at `endReason`, but the record is only stored when the question actually
   * changes or the summary appears, so the row is available for the summary.
   */
  private pendingRecord: QuestionRecord | null = null;
  /**
   * The record of the question on screen that has already been written out.
   *
   * An answered question keeps its record held (see `pendingRecord`) until the
   * question changes, so the card can include the last question of the exercise.
   * Leaving the page writes it out - closing the tab right after answering must
   * not be lossy - but the question itself does not go away: the learner is still
   * looking at it, and the check that catches a question finished by a correct
   * retry ("Check has been replaced by the advance control") keeps firing. So
   * without remembering what has been stored, every tab switch, reload or detour
   * through another practice wrote ANOTHER copy of the same question, and the
   * card then added those copies up and printed one row per copy of the bonus
   * question.
   *
   * Identified by the same three fields the storage layer identifies a stretch
   * with - practice, question and the instant its clock started - so a question
   * the learner RESETS and answers again (a new clock, i.e. a new stretch) is
   * still recorded.
   */
  private storedRecord: QuestionRecord | null = null;
  /** Set while the learner is on the end-of-exercise summary screen. */
  private inSummary = false;
  /** Rows shown on the summary card, kept so settings changes can re-render. */
  private summaryRows: SummaryRow[] = [];
  /** URL the summary was entered on, to notice a real navigation away. */
  private summaryUrl: string | null = null;
  private lastPageCheckAt = 0;
  private summaryView: SummaryView | null = null;
  /**
   * Set when the Skip control is clicked. A skip is only treated as final once
   * the question's progress state actually leaves "incomplete", which
   * distinguishes a confirmed skip from a cancelled one.
   */
  private skipInitiated = false;
  /** True once a question has actually been timed on this page. */
  private seenQuestion = false;
  /**
   * Which question of the exercise is being timed, bound when the question
   * STARTS.
   *
   * Deliberately not re-read from the page while the question is on screen: when
   * the learner advances, the progress marker already shows the NEXT question by
   * the time the change is processed, so reading it late would stamp the new
   * question's number onto the record of the previous one - which is how a
   * summary ends up printing one question's time under another question's
   * number. `learnQuestionPosition()` only fills in a value that was not
   * readable yet, and only while the same question is still on screen.
   */
  private currentQuestionIndex: number | null = null;
  private currentQuestionTotal: number | null = null;
  /**
   * True while the page offers no usable question identity — the state the
   * panel labels "Detection: unidentified". The clock for the question on screen
   * is paused and the floating panel is hidden, so a clock that measures nothing is
   * neither shown nor counted.
   */
  private unidentified = false;
  /**
   * True while the current question's clock is paused *because* the page
   * stopped offering an identifiable question.
   *
   * Only this flag authorises the automatic resume, so a pause the learner
   * asked for is never silently undone when detection comes back.
   */
  private autoPausedForIdentity = false;

  /** The last detector event, in the locale in force right now. */
  private get lastEventText(): string {
    return render(this.lastEvent);
  }

  /** The degradation warning, in the locale in force right now, or null. */
  private get warningText(): string | null {
    return this.warning === null ? null : render(this.warning);
  }

  async init(): Promise<void> {
    this.area = chromeStorageArea();
    this.recordQueue = createRecordQueue(this.area);
    this.settings = await loadSettings(this.area);
    // Resolve the language before anything is mounted or rendered, so the panel
    // is born in the right one instead of being re-lettered a frame later.
    setLocale(this.settings.language);

    const now = Date.now();
    this.recordsCount = (await loadRecords(this.area)).length;
    void pruneSessions(this.area, now);

    this.overlay = new OverlayView(
      {
        onTogglePause: () => this.togglePause(),
        onReset: () => this.resetCurrentQuestion(),
        onToggleCollapse: (collapsed) => void this.updateSettings({ overlayCollapsed: collapsed }),
        onPositionChange: (overlayPosition) => void this.updateSettings({ overlayPosition }),
      },
      this.settings,
    );
    this.overlay.mount();

    this.detector = new QuestionDetector(
      {
        onEvent: (event, snapshot) => this.onDetectionEvent(event, snapshot),
        onDiagnostics: (info) => {
          this.diagnostics = info;
          this.publishDiagnostics();
        },
        onProgressStateChange: (change) => this.onProgressStateChange(change),
      },
      {
        debounceMs: this.settings.detectionDebounceMs,
        cooldownMs: this.settings.detectionCooldownMs,
      },
    );
    this.detector.start();

    this.tickTimer = window.setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.installSubmissionListener();
    this.installNavigationListener();
    this.installLifecycleHooks();
    this.installExtensionHooks();
    this.started = true;
    this.render();
  }

  /* ------------------------------------------------------------ *
   * Detection handling
   * ------------------------------------------------------------ */

  private onDetectionEvent(event: DetectionEvent, snapshot: QuestionSnapshot): void {
    const exerciseKey = exerciseKeyFromUrl(snapshot.url);
    const engine = this.engine;
    const leavingExercise = engine !== null && engine.exerciseKey !== exerciseKey;

    // The page stopped being the exercise being timed. Whether or not the
    // detector can identify anything on the new page, the old question is
    // parked: its timing is never folded into the new exercise's run, and its
    // numbers are never shown there.
    if (leavingExercise) this.parkCurrentQuestion(event.at);

    // The page is not describing a question that is being SOLVED yet. That
    // covers both "no question region" and "a region with nothing but a
    // fingerprint" - an exercise's start card holds the previous question's
    // Perseus framework before the footer's progress marker arrives, and timing
    // that stretch is what used to bill the intro card (and the page load) to
    // the first question, leave it looking paused, and flash the panel.
    //
    // A question is only timed once the page says WHICH question it is - see
    // `isPositionedQuestionKey`. The identity upgrade from fingerprint to
    // position is reported by the detector on the very next observation, and on
    // the real site that is 20-200 ms after the region appears (measured), so
    // nothing meaningful is lost.
    //
    // The clock of a question already being timed is frozen (the engine is KEPT,
    // just paused) while it lasts, and the panel is hidden. Freezing rather than
    // discarding is what keeps the question's time, its record and its summary
    // row alive.
    this.unidentified = !isIdentified(snapshot) || !isPositionedQuestionKey(identityKeyOfSnapshot(snapshot));
    if (this.unidentified) this.pauseForMissingIdentity(event.at);

    // A question whose number was not readable when it started (the progress
    // marker can appear after the question region) is only filled in while the
    // SAME question is on screen, never while it is being finalised.
    if (!leavingExercise && event.type !== 'question-changed') this.learnQuestionPosition();

    switch (event.type) {
      case 'question-changed': {
        const current = this.engine;
        if (!current) {
          // The first question of this exercise (initial detection, or the
          // exercise the learner just arrived at): pick up any session saved
          // for this question earlier. Only a POSITIONED question gets here, so
          // this is also the moment the clock starts for it.
          if (this.unidentified) {
            this.lastEvent = { key: 'event.noQuestionPosition' };
            break;
          }
          void this.beginQuestion(event.to, snapshot, event.at, true);
          break;
        }
        if (current.questionKey === event.to) {
          // Same exercise AND same question under a new URL (an SPA route
          // change, e.g. a query string): keep the clock running rather than
          // restarting it at zero.
          this.currentExerciseKey = exerciseKey;
          this.currentConfidence = snapshot.confidence;
          this.lastEvent = { key: 'event.sameQuestion' };
          break;
        }
        if (this.unidentified) {
          // The identity moved but is not usable yet (e.g. straight to another
          // fingerprint): finalise what was being timed, but do not start the
          // next question's clock on a signal that is not a question.
          void this.finalizeCurrentQuestion(event.at, 'question-change');
          break;
        }
        const now = event.at;
        void this.finalizeCurrentQuestion(now, 'question-change').then(() =>
          this.beginQuestion(event.to, snapshot, now, event.from === null),
        );
        break;
      }
      case 'identity-upgraded': {
        // The same question, now identified by its progress position instead of
        // by a fingerprint. The clock is NOT touched: this is the case that used
        // to restart every question at zero a moment after the page loaded.
        const current = this.engine;
        if (current && current.questionKey === event.from) {
          current.questionKey = event.to;
          current.stemFingerprint = snapshot.stemFingerprint ?? current.stemFingerprint;
          this.currentConfidence = snapshot.confidence;
          this.lastEvent = { key: 'event.identityUpgraded' };
          void this.checkpoint(event.at, true);
          break;
        }
        // Nothing was being timed for the fingerprint the page showed a moment
        // ago (a question region with no position yet: a page load in progress,
        // or a practice start card holding the previous question's framework).
        // Now that the page says which question it is, the clock starts - from
        // zero, and counting only from here.
        if (!current && !this.unidentified) {
          void this.beginQuestion(event.to, snapshot, event.at, true);
        }
        break;
      }
      case 'same-question':
        this.lastEvent = { key: 'event.sameQuestion' };
        break;
      case 'pending':
        this.lastEvent = { key: 'event.pendingChange' };
        break;
      case 'uncertain':
        // Conservative degradation (spec 2.4): never reset or discard the time
        // already spent. The clock is frozen instead of being left running, so
        // a stretch of page the extension cannot read is not billed to the
        // question; the engine survives, so the question can still be finished
        // and still reaches the summary.
        this.warning = this.engine
          ? { key: 'warning.uncertainPaused', params: { reason: event.reason } }
          : { key: 'warning.uncertainHidden', params: { reason: event.reason } };
        this.lastEvent = { key: 'event.uncertain' };
        break;
    }

    // The question that was auto-paused is identifiable again: carry on from
    // the exact value it was frozen at. A different question — or a pause the
    // learner asked for — is left alone.
    if (!this.unidentified) {
      this.resumeAfterIdentityRestored(event, event.at);
      // ... and the warning that described the degraded stretch goes with it.
      // A page that identifies its question again must never keep showing
      // "Cannot reliably identify the current question": the panel is on screen
      // and the clock is running, so the text contradicts what the learner sees. A
      // momentary gap — the SPA swapping the question subtree for a few hundred
      // milliseconds — used to leave that contradiction behind until the next
      // question.
      this.clearIdentityWarning();
    }

    this.render();
  }

  /**
   * Freeze the clock of the question on screen because the page stopped
   * offering an identifiable question ("Detection: unidentified").
   *
   * The engine is deliberately KEPT — only paused — which is what makes the
   * behaviour safe:
   *
   *  - the time already spent on this question survives;
   *  - when the same question is identified again the clock resumes from that
   *    value instead of restarting at zero;
   *  - the question can still be finished and still produces a record, so it
   *    keeps its row in the end-of-exercise summary.
   *
   * Only a *running* clock is frozen, so a pause the learner asked for is left
   * exactly as it is (and never auto-resumed later).
   */
  private pauseForMissingIdentity(now: number): void {
    const engine = this.engine;
    if (!engine || engine.getPhase() !== 'running') return;
    // Automatic: the learner did not press Pause, so `wasPaused` stays false.
    engine.pause(now, true);
    this.autoPausedForIdentity = true;
    this.lastEvent = { key: 'event.unidentifiedPaused' };
    void this.checkpoint(now, true);
  }

  /**
   * The page is identifiable again. Resume only when the identity is the very
   * question whose clock was auto-paused; a different identity is a real
   * question change and goes through the normal finalise/begin flow, and a
   * learner-requested pause is never undone.
   */
  private resumeAfterIdentityRestored(event: DetectionEvent, now: number): void {
    if (!this.autoPausedForIdentity) return;
    const engine = this.engine;
    if (!engine || engine.getPhase() !== 'paused') {
      // The question was finished, replaced or dropped in the meantime.
      this.autoPausedForIdentity = false;
      return;
    }
    if (identityKeyOfEvent(event) !== engine.questionKey) return;
    engine.resume(now);
    this.autoPausedForIdentity = false;
    this.lastEvent = { key: 'event.identityRestored' };
    void this.checkpoint(now, true);
  }

  /**
   * Drop the "Cannot reliably identify the current question" warning.
   *
   * It describes one stretch of page the extension could not read, so it is only
   * true while that stretch lasts. Re-identifying the question ends it — whether
   * or not the clock had been auto-paused (a learner-requested Pause is also
   * resumed-by-identity-free, and must lose the stale text just the same).
   */
  private clearIdentityWarning(): void {
    this.warning = null;
  }

  private async beginQuestion(
    questionKey: string,
    snapshot: QuestionSnapshot,
    now: number,
    allowRestore: boolean,
  ): Promise<void> {
    const token = ++this.flowToken;
    const exerciseKey = exerciseKeyFromUrl(snapshot.url);
    this.currentExerciseKey = exerciseKey;
    this.currentConfidence = snapshot.confidence;

    // Which question of this exercise is being timed is bound HERE, while it is
    // the question on screen. Every record built for it - including one written
    // later, when the page has already moved on - keeps this number.
    const position = readProgress(document);
    this.currentQuestionIndex = position?.index ?? null;
    this.currentQuestionTotal = position?.total ?? null;
    // Open this attempt's window (or keep it): the card is later built from
    // "everything on this practice since the window opened", which survives the
    // attempt id being lost in the middle.
    await ensureAttemptWindow(this.area, exerciseKey, now);

    // One run per pass through the exercise. Reused across page reloads so the
    // summary still covers the whole attempt; replaced once its summary has
    // been shown, or when it is too old to belong to this attempt.
    let run = await loadRun(this.area, exerciseKey, now);
    if (token !== this.flowToken) return;
    if (!run) {
      run = {
        version: 1,
        runId: uniqueId('run'),
        exerciseKey,
        startedAt: now,
        summarizedAt: null,
        lastQuestionIndex: position?.index ?? null,
      };
      void saveRun(this.area, run);
    }
    this.run = run;

    let engine: TimerEngine | null = null;
    let restored = false;

    if (allowRestore && this.settings.resumeAcrossReload) {
      const session = await loadSession(this.area, exerciseKey, now);
      if (token !== this.flowToken) return; // superseded by a newer event
      // Match on the identity OR on the stem hash: on a real page load the
      // question is first seen before the progress marker exists, so a resume
      // can be offered while the page still identifies it by fingerprint.
      if (
        session &&
        (session.questionKey === questionKey ||
          (session.stemFingerprint !== null &&
            snapshot.stemFingerprint !== null &&
            session.stemFingerprint === snapshot.stemFingerprint))
      ) {
        engine = TimerEngine.restore(session, now);
        restored = true;
        // Carry the identity the page reports NOW, so the session and the
        // record use the same (stronger) key from here on.
        engine.questionKey = questionKey;
        engine.stemFingerprint = snapshot.stemFingerprint ?? engine.stemFingerprint;
      }
    }
    if (token !== this.flowToken) return;

    if (!engine) {
      engine = new TimerEngine({
        mode: this.settings.defaultMode,
        limitMs:
          this.settings.defaultMode === 'countdown'
            ? secondsToMs(this.settings.countdownLimitSeconds)
            : null,
        questionKey,
        stemFingerprint: snapshot.stemFingerprint,
        exerciseKey,
        now,
      });
    }

    this.engine = engine;
    // A brand-new question starts with a clean identification state: whatever
    // was paused before belongs to the question that just ended.
    this.unidentified = false;
    this.autoPausedForIdentity = false;
    this.seenQuestion = true;
    this.warning = snapshot.confidence === 'weak' ? { key: 'warning.weakSignal' } : null;
    this.lastEvent = { key: restored ? 'event.resumed' : 'event.started' };
    this.lastCheckpointAt = now;
    void saveSession(this.area, engine.serialize(now));
    this.render();
  }

  /**
   * Fill in the current question's number if the progress marker was not there
   * yet when the question started.
   *
   * Only ever fills a missing value, and only called while the same question is
   * still the one on screen: overwriting a bound number with whatever the page
   * shows at an arbitrary moment would label one question's record with another
   * question's number.
   */
  private learnQuestionPosition(): void {
    if (this.currentQuestionIndex !== null) return;
    const progress = readProgress(document);
    if (!progress) return;
    this.currentQuestionIndex = progress.index;
    this.currentQuestionTotal = progress.total;
  }

  /**
   * Stop timing the current question the moment the learner is done with it —
   * they answered correctly, or they confirmed a skip.
   *
   * The record is built now (so its duration is frozen at this instant) but is
   * held in `pendingRecord` rather than written, because the end-of-exercise
   * summary needs the last question's row and the question has not changed yet.
   */
  private completeCurrentQuestion(now: number, reason: EndReason): void {
    const engine = this.engine;
    if (!engine) return;

    // Self-heal: a held record belonging to a DIFFERENT question means a
    // question change went unnoticed. Persist it rather than letting it block
    // this question's completion (which would silently lose a whole row).
    const held = this.pendingRecord;
    if (
      held !== null &&
      held.questionIndex !== null &&
      this.currentQuestionIndex !== null &&
      held.questionIndex !== this.currentQuestionIndex
    ) {
      this.pendingRecord = null;
      void this.queueRecord(held);
    }
    if (this.pendingRecord !== null) return;

    if (engine.getPhase() === 'finished') {
      const final = engine.snapshot(now);
      // The question is finished AND already stored: the learner answered it,
      // left the page (which wrote the held record out) and came back to it. It
      // is one question, timed once, and it already has its record.
      if (this.isStored(engine, final.startedAt)) return;
      this.pendingRecord = this.buildRecord(engine, final, now, reason);
      return;
    }
    const final = engine.finish(now, reason);
    this.pendingRecord = this.buildRecord(engine, final, now, reason);
    this.autoPausedForIdentity = false;
    this.lastEvent = { key: reason === 'skipped' ? 'event.skipped' : 'event.answeredCorrect' };
    void this.checkpoint(now, true);
    this.render();
  }

  /**
   * Is the stretch the engine is timing already in storage?
   *
   * Compared through the storage layer's own identity for a stretch (practice +
   * question + start), so this can only ever be true for the very same timing of
   * the very same question - see `storedRecord`.
   */
  private isStored(engine: TimerEngine, startedAt: number | null): boolean {
    const stored = this.storedRecord;
    if (stored === null || startedAt === null) return false;
    return (
      stored.exerciseKey === engine.exerciseKey &&
      stored.questionKey === engine.questionKey &&
      stored.startedAt === startedAt
    );
  }

  private async finalizeCurrentQuestion(now: number, reason: EndReason): Promise<void> {
    const engine = this.engine;

    // A question that already completed keeps its frozen duration; the reason
    // recorded is the one that actually stopped the clock.
    const held = this.pendingRecord;
    this.pendingRecord = null;
    this.skipInitiated = false;
    this.autoPausedForIdentity = false;

    if (!engine) {
      if (held) await this.queueRecord(held);
      return;
    }

    const final = engine.getPhase() === 'finished' ? engine.snapshot(now) : engine.finish(now, reason);
    this.engine = null;
    await clearSession(this.area, engine.exerciseKey);

    // A question whose record is already stored (the learner left the page on it
    // and came back) is not recorded a second time - see `storedRecord`.
    const record =
      held ??
      (this.isStored(engine, final.startedAt) ? null : this.buildRecord(engine, final, now, reason));
    if (record === null) return;

    // A question abandoned almost instantly, with no answer ever submitted, is
    // far more likely to be detection noise than a real attempt.
    if (
      record.durationMs < MIN_RECORD_MS &&
      record.firstSubmissionAt === null &&
      record.endReason !== 'skipped'
    ) {
      return;
    }

    await this.queueRecord(record);
  }

  /**
   * Append a record through the single serialised writer (see
   * `createRecordQueue`): the writes fired without being awaited - parking a
   * question when the learner switches practice, the self-heal branch that
   * flushes a stale held record - can therefore never interleave with another
   * one and drop a row of the end-of-exercise card.
   *
   * Landing here is also what marks the question as recorded, which is what
   * stops the same question from being written again while it is still the one
   * on screen: see `storedRecord`.
   */
  private async queueRecord(record: QuestionRecord): Promise<void> {
    const saved = await this.recordQueue.add(record);
    if (saved) {
      this.recordsCount = saved.length;
      this.storedRecord = record;
    }
  }

  /** Resolve once every queued record write has landed. */
  private async flushRecordWrites(): Promise<void> {
    await this.recordQueue.flush();
  }

  /**
   * The learner left the question they were on because the page moved to a
   * different exercise - or to a page with no question at all (course page,
   * video, an exercise's "Ready to practice?" start card).
   *
   * Two things must survive that move, and neither used to:
   *
   *  - a question that was already answered or skipped but whose record is still
   *    held must be written now: the question it was waiting for may never
   *    change, and the learner may never come back;
   *  - a question still being timed must keep its accumulated time, so returning
   *    to the exercise continues from where the learner stopped instead of
   *    restarting at zero.
   *
   * The engine itself is dropped. Leaving it in place is what used to render the
   * previous exercise's clock on the next exercise's start card, where it kept
   * counting time the learner was not spending on that question.
   */
  private parkCurrentQuestion(now: number): void {
    const engine = this.engine;
    if (!engine) return;
    this.engine = null;
    this.skipInitiated = false;
    this.autoPausedForIdentity = false;
    this.warning = null;
    this.currentExerciseKey = exerciseKeyFromUrl(location.href);

    const held = this.pendingRecord;
    this.pendingRecord = null;

    if (held) {
      // The question is finished: its timing is final, so it becomes a record.
      void clearSession(this.area, engine.exerciseKey);
      void this.queueRecord(held);
      this.lastEvent = { key: 'event.switchedSaved' };
    } else {
      // Still being timed: freeze the clock and keep the session resumable.
      const frozen =
        engine.getPhase() === 'finished' ? engine.snapshot(now) : engine.finish(now, 'navigation');
      void saveSession(this.area, parkedSession(engine.serialize(now), frozen.elapsedMs, now));
      this.lastEvent = { key: 'event.switchedParked' };
    }
    this.render();
  }

  private buildRecord(
    engine: TimerEngine,
    final: TimerSnapshot,
    now: number,
    reason: EndReason,
  ): QuestionRecord {
    const submission = engine.getFirstSubmission();
    return {
      id: uniqueId('rec'),
      questionKey: engine.questionKey,
      exerciseKey: engine.exerciseKey,
      startedAt: final.startedAt ?? now,
      endedAt: now,
      durationMs: final.elapsedMs,
      pausedMs: final.pausedMs,
      mode: final.mode,
      limitMs: final.limitMs,
      timedOut: final.expired,
      firstSubmissionAt: submission?.at ?? null,
      firstSubmissionOutcome: submission?.outcome ?? null,
      endReason: reason,
      status: reason === 'skipped' ? 'skipped' : final.expired ? 'expired' : reason === 'page-unload' ? 'partial' : 'completed',
      detectionConfidence: this.currentConfidence,
      wasPaused: engine.hasSeenPause(),
      runId: this.run?.runId ?? '',
      questionIndex: this.currentQuestionIndex,
      questionTotal: this.currentQuestionTotal,
    };
  }

  /* ------------------------------------------------------------ *
   * User actions
   * ------------------------------------------------------------ */

  private togglePause(): void {
    const engine = this.engine;
    if (!engine) return;
    const now = Date.now();
    if (engine.getPhase() === 'paused') {
      engine.resume(now);
      this.lastEvent = { key: 'event.resumedManual' };
    } else {
      // A learner-requested pause is never auto-resumed later.
      engine.pause(now);
      this.lastEvent = { key: 'event.pausedManual' };
    }
    this.autoPausedForIdentity = false;
    void this.checkpoint(now, true);
    this.render();
  }

  private resetCurrentQuestion(): void {
    const engine = this.engine;
    if (!engine) {
      // No timer yet (detection failed): ask the detector to try again.
      this.detector?.reevaluate('manual-reset');
      return;
    }
    const now = Date.now();
    engine.reset(now, true);
    // Resetting after answering correctly puts the question back under timing,
    // so drop the held "completed" record for this question.
    this.pendingRecord = null;
    this.skipInitiated = false;
    this.autoPausedForIdentity = false;
    this.warning = null;
    this.lastEvent = { key: 'event.reset' };
    // Re-evaluate so a reset never looks like a question change.
    this.detector?.reevaluate('manual-reset');
    // Resetting restarts the clock; on a page that is still unrecognised that
    // would immediately contradict "Detection: unidentified", so freeze it again.
    if (this.unidentified && engine.getPhase() === 'running') this.pauseForMissingIdentity(now);
    void this.checkpoint(now, true);
    this.render();
  }

  /**
   * The current question's progress state moved while its index did not.
   *
   * This is what tells us the learner finished with the question they are on:
   *   - `correct`                      -> they answered it right: stop timing
   *   - anything else after a Skip     -> the skip was confirmed: stop timing
   *   - anything else without a Skip   -> a wrong answer; they may retry, so
   *                                       timing deliberately continues
   */
  private onProgressStateChange(change: ProgressStateChange): void {
    if (this.inSummary) return;

    // Settle the first submission's correctness FIRST, so the record that is
    // about to be built carries it. Reading the feedback area on a timer proved
    // unreliable: it usually fired before the page had updated the state, so
    // records were stored with outcome "unknown". The progress state change is
    // the authoritative signal and arrives after the page has settled.
    const engine = this.engine;
    if (engine && engine.getFirstSubmission() !== null) {
      engine.setFirstSubmissionOutcome(change.state === 'correct' ? 'correct' : 'incorrect');
    }

    if (this.pendingRecord !== null) return; // already stopped for this question

    const trigger = completionTriggerFor(change.state, change.previous, this.skipInitiated);
    if (trigger) this.completeCurrentQuestion(Date.now(), trigger);
  }

  /* ------------------------------------------------------------ *
   * End-of-exercise summary
   * ------------------------------------------------------------ */

  /**
   * Watch for the summary screen appearing (and for the learner starting a new
   * attempt from it).
   *
   * The summary replaces the whole question area, so the detector would only
   * report "region not found". This check runs alongside it and takes over once
   * the exercise is finished.
   */
  private checkPageState(now: number): void {
    if (now - this.lastPageCheckAt < SUMMARY_CHECK_INTERVAL_MS) return;
    this.lastPageCheckAt = now;

    const onSummary = isSummaryPage(document);
    if (onSummary && !this.inSummary) {
      // Guard against a false positive while the page is still loading: the
      // exercise chrome exists before the question does, so "no answer form"
      // briefly looks like the summary. Only a page that has actually been
      // timing a question can be finished.
      if (!this.seenQuestion || this.run === null) return;
      // ... and only the summary of THE PRACTICE THIS ATTEMPT BELONGS TO.
      //
      // Measured on khanacademy.org: moving to another practice inside the app
      // tears the old exercise down first, and that torn-down frame has no
      // answer form, no progress markers and still has the exercise chrome - it
      // is byte-for-byte the summary's structural signature, only the URL has
      // already changed. Entering the summary there marked the attempt finished,
      // and the learner's earlier questions then fell out of the card when they
      // came back (their timing was still stored, but under an attempt that was
      // no longer the current one).
      if (this.run.exerciseKey !== exerciseKeyFromUrl(location.href)) return;
      // ... and only after a question was actually FINISHED here.
      //
      // The summary replaces the last question of the exercise, so the clock for
      // it has already been stopped and its record is being held. A page that
      // merely has no question on it - the "Ready to practice?" intro card, or a
      // mid-transition frame - must never open the summary: that is how the card
      // ended up rendered on top of an intro screen, showing "No data yet".
      const lastQuestionFinished =
        this.pendingRecord !== null ||
        (this.engine !== null && this.engine.getPhase() === 'finished');
      if (!lastQuestionFinished) return;
      void this.enterSummary(now);
      return;
    }
    if (this.inSummary) {
      const leave = shouldLeaveSummary({
        onSummary,
        questionFormPresent: document.querySelector('form[name="answerform"]') !== null,
        urlChanged: this.summaryUrl !== null && location.href !== this.summaryUrl,
        startCardPresent: isStartCardPresent(document),
      });
      if (leave) this.leaveSummary();
      return;
    }
    if (onSummary) return;

    // A question finished by a CORRECT RETRY never shows up as a progress state
    // change (the marker keeps the first attempt's "incorrect"), so catch it
    // here instead: the Check button has been replaced by the advance control.
    if (this.pendingRecord === null && this.seenQuestion && isQuestionFinished(document)) {
      this.finishCurrentQuestion(now);
    }
  }

  /**
   * The learner is done with the current question and the clock must stop.
   *
   * Prefers "skipped" when no submission was ever recorded, so a skip that
   * surfaces through the advance control is still labelled correctly.
   */
  private finishCurrentQuestion(now: number): void {
    const engine = this.engine;
    if (!engine) return;
    const skipped = engine.getFirstSubmission() === null && this.skipInitiated;
    this.completeCurrentQuestion(now, skipped ? 'skipped' : 'answered-correct');
  }

  private async enterSummary(now: number): Promise<void> {
    this.inSummary = true;
    this.summaryUrl = location.href;

    // The last question never "changed", so its held record is written here.
    // This is also what makes it available as a summary row.
    await this.finalizeCurrentQuestion(now, 'exercise-complete');

    const exerciseKey = this.currentExerciseKey || exerciseKeyFromUrl(location.href);
    const runId = this.run?.runId ?? '';
    if (this.run) {
      this.run = { ...this.run, summarizedAt: now };
      void saveRun(this.area, this.run);
    }
    // The attempt boundary for this practice, independent of the run id: the
    // card lists what the learner did since the previous summary was shown, so a
    // run id lost mid-attempt no longer hides the earlier questions.
    void markAttemptSummarized(this.area, exerciseKey, now);
    // Stop question tracking: there is no question on this screen.
    this.detector?.stop();
    this.warning = null;
    this.lastEvent = { key: 'event.summaryShown' };

    // Every row below is read from storage: make sure the record of the last
    // question (and any write still in flight, e.g. from parking another
    // practice) has landed first, or a row would be missing.
    await this.flushRecordWrites();
    const records = await loadRecords(this.area);
    // Retrieved by PRACTICE (the route the questions were timed on), then by the
    // attempt window (everything since this practice's last summary), and only
    // then by run id: a card can never show another exercise's rows, and the
    // questions timed before a detour through another practice are found again
    // even when the attempt id changed in the meantime.
    const window = await loadAttemptWindow(this.area, exerciseKey);
    const attempt = attemptRecordsFor(records, exerciseKey, runId, window?.since ?? null);
    // The card is a table of the exercise's questions, in question order, with a
    // "No data" row for a number this attempt never timed.
    const questionTotal =
      attempt.reduce((max, record) => Math.max(max, record.questionTotal ?? 0), 0) ||
      this.currentQuestionTotal;
    const rows: SummaryRow[] = buildSummaryRows({ records: attempt, questionTotal });

    const host = this.findSummaryHost();
    if (!host) {
      this.lastEvent = { key: 'event.summaryNoHost' };
      this.render();
      return;
    }
    this.summaryRows = rows;
    this.summaryView =
      this.summaryView ??
      new SummaryView({
        onToggleCollapsed: (collapsed) => void this.updateSettings({ summaryCollapsed: collapsed }),
      });
    this.summaryView.mount(host.element, host.insert);
    this.renderSummary();
    this.render();
  }

  private leaveSummary(): void {
    this.inSummary = false;
    // NOTE: `seenQuestion` is deliberately NOT reset. It records that this page
    // ever timed a question, which is what keeps a still-loading page from
    // being mistaken for the summary. Resetting it here meant that after a
    // transient non-summary frame the card could never be injected again.
    this.summaryUrl = null;
    this.summaryView?.destroy();
    this.summaryView = null;
    // A new attempt: forget the finished run so records start a fresh one.
    const exerciseKey = this.currentExerciseKey;
    if (exerciseKey) void clearRun(this.area, exerciseKey);
    this.run = null;
    this.pendingRecord = null;
    this.skipInitiated = false;
    this.summaryRows = [];
    this.detector?.start();
    this.lastEvent = { key: 'event.newAttempt' };
    this.render();
  }

  /** Re-render the card from the last rows and the current settings. */
  private renderSummary(): void {
    this.summaryView?.render({
      rows: this.summaryRows,
      collapsed: this.settings.summaryCollapsed,
    });
  }

  private findSummaryHost(): { element: Element; insert: 'before-host' | 'append' } | null {
    for (const strategy of SUMMARY_HOST) {
      let element: Element | null = null;
      try {
        element = strategy.select(document);
      } catch {
        continue;
      }
      if (element) return { element, insert: strategy.insert };
    }
    return null;
  }

  /**
   * Mirror the detector's view of the page onto the overlay host element as
   * `data-khan-timer-diagnostics`.
   *
   * This exists so that "the panel is stuck" is diagnosable from the page
   * itself: it records how many times the detector evaluated, why, the raw
   * progress testid it read, and the identity it derived. It carries no user
   * data - only selector names, a local question fingerprint and counters.
   */
  private publishDiagnostics(): void {
    const host = document.getElementById(OVERLAY_HOST_ID);
    if (!host) return;
    const summary = {
      evaluateCount: this.diagnostics.evaluateCount,
      lastReason: this.diagnostics.lastReason,
      sinceEvaluateMs: this.diagnostics.lastEvaluateAt ? Date.now() - this.diagnostics.lastEvaluateAt : null,
      regionFound: this.diagnostics.regionFound,
      strategy: this.diagnostics.strategy,
      confidence: this.diagnostics.confidence,
      progress: this.diagnostics.progress,
      progressRaw: this.diagnostics.progressRaw,
      questionKey: this.diagnostics.questionKey,
      engineQuestionKey: this.engine?.questionKey ?? null,
      lastEvent: this.lastEventText,
      /**
       * "Detection: unidentified", and whether this question's clock was frozen
       * by the extension because of it. Both are readable from the page even while
       * the panel itself is hidden, which is what makes the behaviour
       * verifiable in a real browser.
       */
      unidentified: this.unidentified,
      autoPausedForIdentity: this.autoPausedForIdentity,
      enginePhase: this.engine?.getPhase() ?? null,
      errors: this.diagnostics.errors,
      stopped: this.diagnostics.stopped,
      pollTicks: this.diagnostics.pollTicks,
      mutationCallbacks: this.diagnostics.mutationCallbacks,
      regionConnected: this.diagnostics.regionConnected,
      progressContainerConnected: this.diagnostics.progressContainerConnected,
      hasRegionObserver: this.diagnostics.hasRegionObserver,
      hasProgressObserver: this.diagnostics.hasProgressObserver,
      hasBodyObserver: this.diagnostics.hasBodyObserver,
      pollTimerActive: this.diagnostics.pollTimerActive,
      pendingCandidate: this.diagnostics.pendingCandidate,
      tickCount: this.tickCount,
      disposed: this.disposed,
      visibility: document.visibilityState,
      hidden: document.hidden,
    };
    host.setAttribute('data-khan-timer-diagnostics', JSON.stringify(summary));
  }

  /* ------------------------------------------------------------ *
   * Ticking, checkpointing, rendering
   * ------------------------------------------------------------ */

  private tick(): void {
    this.tickCount += 1;
    if (!this.started) return;
    const now = Date.now();
    this.syncExerciseContext(now);
    const engine = this.engine;
    if (engine && engine.getPhase() === 'running') {
      const result = engine.tick(now);
      if (result.expiredJustNow && this.settings.soundEnabled) {
        if (playExpiryTone()) this.lastEvent = { key: 'event.countdownEndedTone' };
        else this.lastEvent = { key: 'event.countdownEndedToneBlocked' };
      } else if (result.expiredJustNow) {
        this.lastEvent = { key: 'event.countdownEnded' };
      }
      if (now - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        void this.checkpoint(now, false);
      }
    }
    // Refresh the detector's diagnostics roughly once a second so the panel's
    // support attribute reflects reality even when nothing is changing.
    if (this.tickCount % 4 === 0) this.detector?.refreshDiagnostics();
    this.checkPageState(now);
    this.render();
  }

  private async checkpoint(now: number, force: boolean): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.settings.resumeAcrossReload) return;
    if (!force && now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    this.lastCheckpointAt = now;
    await saveSession(this.area, engine.serialize(now));
  }

  /**
   * Has the page moved away from the exercise being timed?
   *
   * The detector reports a question change only when it can find a question:
   * leaving an exercise for another exercise's "Ready to practice?" start card,
   * a video or the course page produces nothing but "region not found". The
   * page's own exercise identity is therefore compared here, so the question
   * being timed is parked (and the panel hidden) as soon as the page belongs to
   * something else.
   */
  private syncExerciseContext(now: number): void {
    const engine = this.engine;
    if (!engine || this.inSummary) return;
    if (engine.exerciseKey === exerciseKeyFromUrl(location.href)) return;
    this.parkCurrentQuestion(now);
  }

  /**
   * Should the floating panel be on screen?
   *
   * One question, one answer: is a question being SOLVED on the page in front of
   * the learner right now? That is the only reason the panel exists, so every
   * "no" hides it:
   *
   *  - the learner turned the overlay off (the master switch);
   *  - no question is being timed at all — which includes "the page has content
   *    that looks like a question but has not said WHICH question it is": an
   *    engine is only ever created for a positioned question (see
   *    `onDetectionEvent`), so a start card's leftover Perseus region, a page
   *    load in progress and a torn-down frame all land here;
   *  - "Detection: unidentified" (the page stopped offering an identity): a panel
   *    there would advertise a clock for a question the extension cannot even name;
   *  - the engine still belongs to the practice the learner just LEFT, whose
   *    numbers have no meaning on the new page.
   *
   * Deliberately a short, ordered list of conditions and no accumulated state:
   * the panel is a pure function of "what is being timed on the page that is
   * loaded", recomputed from scratch on every render.
   */
  private shouldShowPanel(): boolean {
    if (!this.settings.overlayVisible) return false;
    const engine = this.engine;
    if (!engine) return false;
    if (this.unidentified) return false;
    return engine.exerciseKey === exerciseKeyFromUrl(location.href);
  }

  private render(): void {
    if (!this.overlay) return;
    this.overlay.setVisible(this.shouldShowPanel());
    const now = Date.now();
    const engine = this.engine;
    const snapshot = engine ? engine.snapshot(now) : null;

    const state: OverlayState = {
      mode: snapshot?.mode ?? this.settings.defaultMode,
      phase: snapshot?.phase ?? 'idle',
      expired: snapshot?.expired ?? false,
      elapsedMs: snapshot?.elapsedMs ?? 0,
      remainingMs: snapshot?.remainingMs ?? null,
      limitMs: snapshot?.limitMs ?? null,
      questionKey: engine?.questionKey ?? null,
      progress: this.diagnostics.progress,
      confidence: this.diagnostics.confidence,
      warning: this.warningText,
      lastEvent: this.lastEventText,
      savedRecords: this.recordsCount,
    };
    this.overlay.render(state);
    this.publishDiagnostics();
  }

  /* ------------------------------------------------------------ *
   * First-answer-submission capture (spec 2.4)
   * ------------------------------------------------------------ */

  private installSubmissionListener(): void {
    if (this.submissionListenerInstalled) return;
    this.submissionListenerInstalled = true;
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${OVERLAY_HOST_ID}`)) return;
        if (!this.isSubmitControl(target)) return;
        // Submitting through Check is not a skip, even if Skip was opened and
        // dismissed earlier.
        this.skipInitiated = false;
        this.noteSubmission(Date.now());
      },
      true,
    );
  }

  private isSubmitControl(target: Element): boolean {
    return clickedControl(target, SUBMIT_BUTTON) !== null;
  }

  private noteSubmission(at: number): void {
    const engine = this.engine;
    if (!engine) return;
    const isFirst = engine.markFirstSubmission(at, 'unknown');
    if (isFirst) {
      this.lastEvent = { key: 'event.firstSubmission' };
      void this.checkpoint(Date.now(), true);
    }
    // The feedback area renders shortly after the click; read it once settled.
    window.setTimeout(() => {
      const outcome = this.readFeedbackOutcome();
      if (outcome === 'unknown') return;
      const engineNow = this.engine;
      if (!engineNow) return;
      if (engineNow.setFirstSubmissionOutcome(outcome)) {
        this.lastEvent = {
          key:
            outcome === 'correct' ? 'event.firstSubmissionCorrect' : 'event.firstSubmissionIncorrect',
        };
        void this.checkpoint(Date.now(), true);
        this.render();
      }
    }, FEEDBACK_SETTLE_MS);
  }

  private readFeedbackOutcome(): FirstSubmissionOutcome {
    // Primary: the progress marker's state segment, e.g. "...-incorrect-current".
    // Structural and locale-independent (verified by observation).
    const structural = readSubmissionOutcome(document);
    if (structural !== 'unknown') return structural;

    // Fallback for page types without a progress marker: the feedback dialog.
    const test = (strategies: typeof CORRECT_INDICATORS): boolean => {
      for (const strategy of strategies) {
        try {
          if (strategy.select(document)) return true;
        } catch {
          /* invalid selector: skip */
        }
      }
      return false;
    };
    if (test(INCORRECT_INDICATORS)) return 'incorrect';
    if (test(CORRECT_INDICATORS)) return 'correct';
    return 'unknown';
  }

  /**
   * Khan Academy's "Start over" regenerates a fresh problem at the same
   * progress index, so the detector cannot see it as a change on its own.
   * Clicking the control is treated as an explicit reseed.
   */
  private installNavigationListener(): void {
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${OVERLAY_HOST_ID}`)) return;
        if (clickedControl(target, SKIP_BUTTON) !== null) {
          // Only a *confirmed* skip stops the clock; see onProgressStateChange.
          this.skipInitiated = true;
          this.lastEvent = { key: 'event.skipClicked' };
          this.render();
          return;
        }
        if (clickedControl(target, START_OVER_BUTTON) === null) return;
        // Let the SPA swap the question, then restart from scratch.
        window.setTimeout(() => {
          void this.finalizeCurrentQuestion(Date.now(), 'manual-reset');
          this.engine = null;
          this.detector?.reseed('start-over');
        }, 400);
      },
      true,
    );
  }

  /* ------------------------------------------------------------ *
   * Lifecycle and extension hooks
   * ------------------------------------------------------------ */

  private installLifecycleHooks(): void {
    // Persist before the page goes away so closing mid-question is not lossy.
    const flush = (): void => {
      const now = Date.now();
      void this.checkpoint(now, true);
      if (this.engine) {
        // Record the partial attempt as well; the session remains resumable.
        const saved = this.engine.serialize(now);
        void saveSession(this.area, saved);
      }
      // A question that was already finished (answered correctly or skipped)
      // whose record is still being held must be written NOW: the learner is
      // leaving, and nothing else will ever come along to finalise it. Without
      // this the last answer of a session disappears from the history whenever
      // the page is closed, reloaded or navigated away from before the next
      // question renders.
      const held = this.pendingRecord;
      if (held) {
        this.pendingRecord = null;
        void this.queueRecord(held);
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  private installExtensionHooks(): void {
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        const change = changes['settings'];
        if (!change) return;
        const previous = this.settings;
        this.settings = sanitizeSettings(change.newValue);
        // A language change must reach everything already on screen. The panel
        // and the summary card re-letter their own labels, and the event and
        // warning text needs no special handling at all: both are stored as
        // message references and are re-rendered from the catalog on every
        // paint, so a stale translation cannot survive the switch.
        if (previous.language !== this.settings.language) {
          setLocale(this.settings.language);
          this.overlay?.applyLanguage();
          this.summaryView?.applyLanguage();
        }
        this.detector?.configure({
          debounceMs: this.settings.detectionDebounceMs,
          cooldownMs: this.settings.detectionCooldownMs,
        });
        this.overlay?.applySettings(this.settings);

        // Apply a mode / limit change to the question that is currently being
        // timed, so the user gets immediate feedback instead of having to wait
        // for the next question. Elapsed time is preserved (spec 2.2).
        const engine = this.engine;
        if (engine && engine.getPhase() !== 'finished') {
          const modeChanged = previous.defaultMode !== this.settings.defaultMode;
          const limitChanged = previous.countdownLimitSeconds !== this.settings.countdownLimitSeconds;
          if (modeChanged || (limitChanged && this.settings.defaultMode === 'countdown')) {
            const now = Date.now();
            engine.setMode(
              this.settings.defaultMode,
              this.settings.defaultMode === 'countdown'
                ? secondsToMs(this.settings.countdownLimitSeconds)
                : null,
              now,
            );
            this.lastEvent = {
              key:
                this.settings.defaultMode === 'countdown'
                  ? 'event.modeCountdown'
                  : 'event.modeCountup',
            };
            void this.checkpoint(now, true);
          }
        }
        this.render();
      });
    }

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
        if (!isStatusRequest(message)) return undefined;
        void this.buildStatusResponse().then(sendResponse);
        return true; // keep the channel open for the async response
      });
    }
  }

  private async buildStatusResponse(): Promise<unknown> {
    const now = Date.now();
    const engine = this.engine;
    const snapshot = engine ? engine.snapshot(now) : null;
    const records = await loadRecords(this.area);
    return {
      ok: true,
      settings: this.settings,
      url: location.href,
      exerciseKey: this.currentExerciseKey,
      questionKey: engine?.questionKey ?? null,
      display: formatDuration(
        snapshot?.mode === 'countdown' && !snapshot.expired
          ? (snapshot.remainingMs ?? 0)
          : (snapshot?.elapsedMs ?? 0),
      ),
      snapshot,
      savedRecords: records.length,
      recent: records.slice(-10),
      diagnostics: this.diagnostics,
      warning: this.warningText,
      lastEvent: this.lastEventText,
      // "Detection: unidentified" with the question's clock frozen. The panel is
      // hidden in this state, so this is how the learner finds out what happened.
      pausedForUnidentified: this.autoPausedForIdentity,
      // Quiz / unit-test / course-challenge pages sit behind an intro card, so
      // "no question yet" there means "not started", not "unsupported".
      startCard: isStartCardPresent(document),
    };
  }

  private async updateSettings(patch: Partial<Settings>): Promise<void> {
    const next: Settings = { ...this.settings, ...patch };
    this.settings = next;
    this.overlay?.applySettings(next);
    await saveSettings(this.area, next);
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.detector?.stop();
    this.overlay?.destroy();
    disposeAudio();
  }
}

/**
 * Does a clicked element belong to the control described by one of these
 * strategies? Resolves the strategy's element from the document and checks
 * containment, so a click on an inner `<span>` label still counts.
 */
function clickedControl(
  target: Element,
  strategies: typeof SUBMIT_BUTTON,
): string | null {
  for (const strategy of strategies) {
    let element: Element | null = null;
    try {
      element = strategy.select(document);
    } catch {
      continue;
    }
    if (element && (element === target || element.contains(target))) return strategy.name;
  }
  return null;
}

function isStatusRequest(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'khan-timer:get-status'
  );
}

/**
 * Does this observation describe a question we can name?
 *
 * `confidence: 'none'` is exactly "no usable identity", whether that is because
 * no question region was found or because the region exposed nothing to key on.
 * It is the same condition the panel renders as "Detection: unidentified".
 */
function isIdentified(snapshot: QuestionSnapshot): boolean {
  return snapshot.regionFound && snapshot.confidence !== 'none';
}

/**
 * The identity key this observation offers, built exactly the way the detector's
 * decider builds it, so "is there a position?" is asked about the same key the
 * timer will be created with.
 */
function identityKeyOfSnapshot(snapshot: QuestionSnapshot): string | null {
  return isIdentified(snapshot) ? identityKeyOf(snapshot) : null;
}

/**
 * The identity an event observed, or null when it carries none.
 *
 * Taken from the event rather than the snapshot so it is the exact key the
 * decider compared against — that is what makes "the paused question is back"
 * an equality test rather than a guess.
 */
function identityKeyOfEvent(event: DetectionEvent): string | null {
  switch (event.type) {
    case 'question-changed':
      return event.to;
    case 'identity-upgraded':
      return event.to;
    case 'same-question':
      return event.key;
    case 'pending':
      return event.candidate;
    case 'uncertain':
      return null;
  }
}
