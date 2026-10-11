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
  type DetectorDiagnostics,
  type ProgressStateChange,
} from './question-detector.js';
import { OverlayView, type OverlayState } from './overlay.js';
import { SummaryView } from './summary-view.js';
import { TimerEngine, formatDuration } from './timer-engine.js';
import { disposeAudio, playExpiryTone } from './sound.js';
import {
  addRecord,
  chromeStorageArea,
  clearRun,
  clearSession,
  loadRecords,
  loadRun,
  loadSession,
  loadSettings,
  parkedSession,
  pruneSessions,
  recordsForRun,
  sanitizeSettings,
  saveRun,
  saveSession,
  saveSettings,
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
  private lastEventText = '正在初始化…';
  private warning: string | null = null;
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

  /** The run (one pass through the exercise) that records are tagged with. */
  private run: ActiveRun | null = null;
  /**
   * A completed question whose record has not been written yet. Timing stopped
   * at `endReason`, but the record is only stored when the question actually
   * changes or the summary appears, so the row is available for the summary.
   */
  private pendingRecord: QuestionRecord | null = null;
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
  /** Position of the question being timed, for the summary rows. */
  private currentQuestionIndex: number | null = null;
  private currentQuestionTotal: number | null = null;

  async init(): Promise<void> {
    this.area = chromeStorageArea();
    this.settings = await loadSettings(this.area);

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

    // The progress position describes a question on THIS page. Reading it while
    // the learner has already moved to another exercise would stamp the wrong
    // index onto the record being parked.
    if (!leavingExercise) {
      const progress = readProgress(document);
      if (progress) {
        this.currentQuestionIndex = progress.index;
        this.currentQuestionTotal = progress.total;
      }
    }

    // The page stopped being the exercise being timed. Whether or not the
    // detector can identify anything on the new page, the old question is
    // parked: its timing is never folded into the new exercise's run, and its
    // numbers are never shown there.
    if (leavingExercise) this.parkCurrentQuestion(event.at);

    switch (event.type) {
      case 'question-changed': {
        const current = this.engine;
        if (!current) {
          // The first question of this exercise (initial detection, or the
          // exercise the learner just arrived at): pick up any session saved
          // for this question earlier.
          void this.beginQuestion(event.to, snapshot, event.at, true);
          break;
        }
        if (current.questionKey === event.to) {
          // Same exercise AND same question under a new URL (an SPA route
          // change, e.g. a query string): keep the clock running rather than
          // restarting it at zero.
          this.currentExerciseKey = exerciseKey;
          this.currentConfidence = snapshot.confidence;
          this.lastEventText = '题目未变化，计时继续';
          break;
        }
        const now = event.at;
        void this.finalizeCurrentQuestion(now, 'question-change').then(() =>
          this.beginQuestion(event.to, snapshot, now, event.from === null),
        );
        break;
      }
      case 'same-question':
        this.lastEventText = '题目未变化，计时继续';
        break;
      case 'pending':
        this.lastEventText = '检测到可能的题目变化，等待确认…';
        break;
      case 'uncertain':
        // Conservative degradation (spec 2.4): keep timing, tell the user.
        this.warning = `无法可靠识别题目变化（${event.reason}）。计时保持不变，可用"重置本题"手动开始。`;
        this.lastEventText = '识别不确定';
        break;
    }
    this.render();
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
        lastQuestionIndex: readProgress(document)?.index ?? null,
      };
      void saveRun(this.area, run);
    }
    this.run = run;

    let engine: TimerEngine | null = null;
    let restored = false;

    if (allowRestore && this.settings.resumeAcrossReload) {
      const session = await loadSession(this.area, exerciseKey, now);
      if (token !== this.flowToken) return; // superseded by a newer event
      if (session && session.questionKey === questionKey) {
        engine = TimerEngine.restore(session, now);
        restored = true;
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
        exerciseKey,
        now,
      });
    }

    this.engine = engine;
    this.seenQuestion = true;
    this.warning =
      snapshot.confidence === 'weak'
        ? '题目识别仅依赖弱信号（进度标记），可能无法自动检测切题。请使用"重置本题"。'
        : null;
    this.lastEventText = restored ? '已恢复上次的计时' : '检测到新题目，计时开始';
    this.lastCheckpointAt = now;
    void saveSession(this.area, engine.serialize(now));
    this.render();
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
      void this.storeRecord(held);
    }
    if (this.pendingRecord !== null) return;

    if (engine.getPhase() === 'finished') {
      this.pendingRecord = this.buildRecord(engine, engine.snapshot(now), now, reason);
      return;
    }
    const final = engine.finish(now, reason);
    this.pendingRecord = this.buildRecord(engine, final, now, reason);
    this.lastEventText =
      reason === 'skipped' ? '已跳过，本题计时已停止' : '答对，本题计时已停止';
    void this.checkpoint(now, true);
    this.render();
  }

  private async finalizeCurrentQuestion(now: number, reason: EndReason): Promise<void> {
    const engine = this.engine;

    // A question that already completed keeps its frozen duration; the reason
    // recorded is the one that actually stopped the clock.
    const held = this.pendingRecord;
    this.pendingRecord = null;
    this.skipInitiated = false;

    if (!engine) {
      if (held) await this.storeRecord(held);
      return;
    }

    const final = engine.getPhase() === 'finished' ? engine.snapshot(now) : engine.finish(now, reason);
    this.engine = null;
    await clearSession(this.area, engine.exerciseKey);

    const record = held ?? this.buildRecord(engine, final, now, reason);

    // A question abandoned almost instantly, with no answer ever submitted, is
    // far more likely to be detection noise than a real attempt.
    if (
      record.durationMs < MIN_RECORD_MS &&
      record.firstSubmissionAt === null &&
      record.endReason !== 'skipped'
    ) {
      return;
    }

    await this.storeRecord(record);
  }

  private async storeRecord(record: QuestionRecord): Promise<void> {
    const saved = await addRecord(this.area, record);
    if (saved) this.recordsCount = saved.length;
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
    this.warning = null;
    this.currentExerciseKey = exerciseKeyFromUrl(location.href);

    const held = this.pendingRecord;
    this.pendingRecord = null;

    if (held) {
      // The question is finished: its timing is final, so it becomes a record.
      void clearSession(this.area, engine.exerciseKey);
      void this.storeRecord(held);
      this.lastEventText = '已切到别的练习，上一题用时已保存';
    } else {
      // Still being timed: freeze the clock and keep the session resumable.
      const frozen =
        engine.getPhase() === 'finished' ? engine.snapshot(now) : engine.finish(now, 'navigation');
      void saveSession(this.area, parkedSession(engine.serialize(now), frozen.elapsedMs, now));
      this.lastEventText = '已切到别的练习，本题计时已暂存';
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
      this.lastEventText = '已继续计时';
    } else {
      engine.pause(now);
      this.lastEventText = '已暂停计时';
    }
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
    this.warning = null;
    this.lastEventText = '已重置本题计时';
    // Re-evaluate so a reset never looks like a question change.
    this.detector?.reevaluate('manual-reset');
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
      // Entering also requires a run that has really been timing questions
      // here, so a page that merely looks like a summary is ignored.
      if (!this.seenQuestion || this.run === null) return;
      void this.enterSummary(now);
      return;
    }
    if (this.inSummary) {
      const leave = shouldLeaveSummary({
        onSummary,
        questionFormPresent: document.querySelector('form[name="answerform"]') !== null,
        urlChanged: this.summaryUrl !== null && location.href !== this.summaryUrl,
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
    // Stop question tracking: there is no question on this screen.
    this.detector?.stop();
    this.warning = null;
    this.lastEventText = '本轮已完成，已显示每题用时';

    const records = await loadRecords(this.area);
    const runRecords = recordsForRun(records, runId);
    // Rows follow capture order, which keeps them unambiguous even though the
    // page's own index restarts for a bonus question.
    let highestIndex = -1;
    const rows: SummaryRow[] = runRecords.map((record, position) => {
      const index = record.questionIndex;
      const bonus = index !== null && index <= highestIndex;
      if (index !== null) highestIndex = Math.max(highestIndex, index);
      return {
        questionNumber: position + 1,
        bonus,
        durationMs: record.durationMs,
        pausedMs: record.pausedMs,
        mode: record.mode,
        limitMs: record.limitMs,
        timedOut: record.timedOut,
        skipped: record.status === 'skipped' || record.endReason === 'skipped',
        firstSubmissionOutcome: record.firstSubmissionOutcome,
        endReason: record.endReason,
      };
    });

    const host = this.findSummaryHost();
    if (!host) {
      this.lastEventText = '本轮已完成，但未找到可插入用时的位置';
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
    this.lastEventText = '检测到新一轮答题';
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
        if (playExpiryTone()) this.lastEventText = '倒计时结束，已提示';
        else this.lastEventText = '倒计时结束（提示音被浏览器阻止）';
      } else if (result.expiredJustNow) {
        this.lastEventText = '倒计时结束';
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
   * It tracks whether a question is actually being timed: the panel appears
   * when one is detected and disappears when there is nothing to time. That
   * keeps it off course pages, videos and any page whose structure is not
   * recognised, instead of showing a clock that measures nothing.
   *
   * An engine that exists but whose detection has since become `uncertain`
   * keeps the panel visible on purpose: the learner is mid-question and still
   * needs the pause / reset controls. Hiding it there would make a transient
   * page hiccup look like the extension had vanished.
   *
   * What must never happen is showing the PREVIOUS exercise's clock: between an
   * SPA route change and the next detection the engine can still belong to the
   * exercise the learner just left, and its numbers have no meaning on the new
   * page.
   */
  private shouldShowPanel(): boolean {
    if (!this.settings.overlayVisible) return false; // user's master switch
    if (this.inSummary) return false; // nothing is being timed here
    const engine = this.engine;
    if (!engine) return false;
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
      warning: this.warning,
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
      this.lastEventText = '已记录第一次提交时间';
      void this.checkpoint(Date.now(), true);
    }
    // The feedback area renders shortly after the click; read it once settled.
    window.setTimeout(() => {
      const outcome = this.readFeedbackOutcome();
      if (outcome === 'unknown') return;
      const engineNow = this.engine;
      if (!engineNow) return;
      if (engineNow.setFirstSubmissionOutcome(outcome)) {
        this.lastEventText =
          outcome === 'correct' ? '第一次提交：正确' : '第一次提交：错误（已记录时间戳）';
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
          this.lastEventText = '已点击跳过，等待确认…';
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
            this.lastEventText =
              this.settings.defaultMode === 'countdown' ? '已切换为倒计时' : '已切换为正计时';
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
      warning: this.warning,
      lastEvent: this.lastEventText,
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
