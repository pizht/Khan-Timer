/**
 * Centralised Khan Academy adaptation rules.
 *
 * Spec 2.4 requires every site selector to live in one place rather than being
 * scattered through the modules, and the pre-implementation research phase
 * requires that selectors come from real observation rather than guesswork.
 *
 * Every entry below is marked with how it was established:
 *
 *   [OBS] observed in real DOM captured from khanacademy.org with headless
 *         Edge (see references/collection-report.md for URLs and method).
 *   [VER] verified by driving the live page over the DevTools Protocol and
 *         comparing behaviour before/after an interaction.
 *   [STD] a platform-standard hook (ARIA role, element semantics) rather than
 *         a site-specific guess, used purely as a defensive fallback.
 *
 * Deliberately avoided:
 *   - hashed CSS class names such as `_7zhre1` / `_xa8e8o1`. Emotion and
 *     styled-components hashes change on every Khan Academy build.
 *   - `[data-testid="content-panel-wrapper"]` as the question region: it
 *     [VER] grows to include the "Related content" sidebar after an answer is
 *     submitted, so its text is not stable across answering.
 *   - the full `exercise-progress-<i>-<state>[-current]` testid as an identity:
 *     the <state> segment [VER] changes from `incomplete` to `incorrect` the
 *     moment an answer is submitted, which would look like a question change.
 */

import type { FirstSubmissionOutcome } from './types.js';

/** A named selector strategy. The `name` appears in diagnostic output. */
export interface SelectorStrategy {
  /** Stable identifier shown in the popup's diagnostics list. */
  name: string;
  select: (root: ParentNode) => Element | null;
}

const first = (selector: string) => (root: ParentNode): Element | null =>
  root.querySelector(selector);

/**
 * The question region: the subtree whose content defines "the current
 * question". Everything hashed out here is stable across answering.
 */
export const QUESTION_REGION: SelectorStrategy[] = [
  // [OBS][VER] Perseus renders the whole question, including every answer
  // widget, inside a form with this name. Its text was byte-identical before
  // and after submitting an answer.
  { name: 'perseus-answerform', select: first('form[name="answerform"]') },
  // [OBS] The framework wrapper around the renderer. Stable across answering;
  // also matches when the answer form itself is not rendered.
  { name: 'perseus-framework', select: first('.framework-perseus') },
  // [OBS] The responsive renderer root. Last resort: narrower than the
  // framework, so it may miss widgets rendered outside the renderer.
  { name: 'perseus-renderer', select: first('.perseus-renderer') },
];

/**
 * Narrower stem lookup inside the region. When none matches, the whole
 * region (minus excluded subtrees) is used as the stem.
 */
export const QUESTION_STEM: SelectorStrategy[] = [
  // [OBS] The responsive renderer holds the full question content. On the
  // captured page its text was exactly the stem ("Add.608+251") and was
  // byte-identical before and after an answer was submitted.
  { name: 'perseus-renderer-root', select: first('.perseus-renderer') },
  // [OBS] Fallback: Perseus tags each question paragraph with its index.
  { name: 'perseus-paragraph-index', select: first('[data-perseus-paragraph-index]') },
];

/**
 * Subtrees removed from the region before it is fingerprinted.
 *
 * These are [STD] platform hooks, plus the observed feedback container. The
 * empirical reason this matters is recorded in references/observations.md:
 * opening hints grew the region's text from ~3.5 KB to ~23 KB, so a naive
 * text fingerprint would report a question change every time a learner asked
 * for help.
 */
export const FEEDBACK_SUBTREES: string[] = [
  '[role="dialog"]', // [OBS] feedback popovers ("Not quite yet...", "There you go!")
  '[role="alert"]', // [STD] assertive announcements
  '[aria-live]', // [STD] polite announcements, e.g. result banners
];

/**
 * Hint / solution subtrees removed before fingerprinting.
 *
 * Deliberately EMPTY: no stable, non-hashed selector for the hint container
 * could be established from observation, so none is invented here.
 *
 * This is not a gap in the design, because the primary question identity is the
 * progress marker's *index* (see `readProgress`), which observation proved does
 * NOT move when auxiliary content appears:
 *
 *   [VER] After confirming "Yes, skip", the hints for the current question all
 *   expanded inside `form[name="answerform"]`, growing that region's text from
 *   ~3.5 KB to ~23 KB, while `exercise-progress-<i>-...-current` stayed on the
 *   same index. Index-based identity is therefore immune to this by
 *   construction, and `test/detector.test.ts` locks the behaviour in with a
 *   regression test.
 *
 * The fallback fingerprint path (used only when no progress marker exists, i.e.
 * on a page type that has NOT been verified) still strips `FEEDBACK_SUBTREES`,
 * and the overlay reports reduced confidence so degraded detection is visible
 * rather than silently wrong.
 */
export const HINT_SUBTREES: string[] = [];

/**
 * Answer widget markers used to build a structural signature.
 * [OBS] `.perseus-widget-container` and the `perseus-input` widget class were
 * both present on the captured exercise page.
 */
export const ANSWER_WIDGET_MARKERS: { name: string; selector: string }[] = [
  { name: 'radio', selector: 'input[type="radio"]' },
  { name: 'checkbox', selector: 'input[type="checkbox"]' },
  { name: 'text', selector: 'input[type="text"], input:not([type])' },
  { name: 'textarea', selector: 'textarea' },
  { name: 'select', selector: 'select' },
  { name: 'editable', selector: '[contenteditable="true"]' },
  { name: 'widget', selector: '.perseus-widget-container' },
  { name: 'choice', selector: '[role="radio"], [role="checkbox"], [role="option"]' },
];

/**
 * Per-question stable identifiers.
 *
 * [VER] Verified ABSENT on the tested exercise page: `data-question-id`,
 * `data-item-id`, `data-problem-id`, `data-perseus-id` and `data-question` all
 * returned zero matches. Khan Academy does not expose a per-question id here,
 * so the fingerprint path is the one that actually runs. The list is kept so
 * that a page which *does* expose one is used without touching the detector.
 */
export const STABLE_QUESTION_ID_ATTRS: string[] = [
  'data-question-id',
  'data-item-id',
  'data-problem-id',
];

/**
 * The container that holds the progress indicator and the exercise controls.
 *
 * [OBS] The progress cells live here, in the exercise footer, which is OUTSIDE
 * the question region. Watching it as well means a progress-index change (i.e.
 * a real question advance) is noticed immediately rather than waiting for the
 * next poll.
 */
export const PROGRESS_CONTAINER: SelectorStrategy[] = [
  { name: 'content-library-footer', select: first('[data-testid="content-library-footer"]') },
];

/** Progress indicator container, searched from the document root. */
export const QUESTION_PROGRESS_STRATEGIES: SelectorStrategy[] = [
  // [OBS] One element per problem, testid format
  // `exercise-progress-<index>-<state>` with `-current` on the active one.
  { name: 'exercise-progress-testid', select: (root) => {
    const cells = root.querySelectorAll('[data-testid^="exercise-progress-"]');
    for (const cell of Array.from(cells)) {
      if ((cell.getAttribute('data-testid') ?? '').endsWith('-current')) return cell;
    }
    return null;
  } },
];

/** Submit / check-answer control, also used to timestamp the first submission. */
export const SUBMIT_BUTTON: SelectorStrategy[] = [
  // [OBS] The exercise's primary "Check" button.
  { name: 'exercise-check-answer', select: first('[data-testid="exercise-check-answer"]') },
];

/** The control that advances to the next question once a question is done. */
export const NEXT_QUESTION_BUTTON: SelectorStrategy[] = [
  // [OBS] Replaces the check button after a correct answer.
  { name: 'exercise-next-question', select: first('[data-testid="exercise-next-question"]') },
];

/**
 * Has the current question been finished?
 *
 * [VER] Khan Academy REPLACES the Check button with the advance control once a
 * question is done, and this is the only reliable signal for a correct answer
 * on a RETRY.
 *
 * Why the progress state word is not enough: the marker keeps the FIRST
 * attempt's verdict. Observed directly — a question answered wrong and then
 * right stayed `exercise-progress-0-incorrect-current` for the rest of the
 * question, while the buttons swapped to `exercise-next-question`:
 *
 *     after a wrong answer:  check-answer present, next-question ABSENT
 *     after a correct retry: check-answer ABSENT,  next-question present
 *
 * So `completionTriggerFor()` (which reads the state word) handles a first-try
 * correct answer promptly, and this predicate catches the retry case. Both are
 * idempotent: whichever fires first sets the held record, and the other is then
 * a no-op.
 */
export function isQuestionFinished(doc: ParentNode): boolean {
  return (
    doc.querySelector('[data-testid="exercise-next-question"]') !== null &&
    doc.querySelector('[data-testid="exercise-check-answer"]') === null
  );
}

/** Skip control. Advancing this way opens a confirmation dialog [VER]. */
export const SKIP_BUTTON: SelectorStrategy[] = [
  { name: 'exercise-skip-button', select: first('[data-testid="exercise-skip-button"]') },
];

/** Start-over control, which resets the whole exercise. */
export const START_OVER_BUTTON: SelectorStrategy[] = [
  { name: 'start-over-button', select: first('[data-testid="start-over-button"]') },
];

/**
 * Correct / incorrect markers.
 *
 * The primary marker is the *state segment* of the current progress cell
 * (`...-incorrect-current` [VER]), because it is structural, locale-independent
 * and does not depend on hashed class names. The dialog text is a secondary
 * fallback for page types without a progress indicator.
 */
export const CORRECT_INDICATORS: SelectorStrategy[] = [
  { name: 'dialog-correct-text', select: (root) =>
      matchDialogText(root, /there you go|keep it up|nice work|correct/i) },
];

export const INCORRECT_INDICATORS: SelectorStrategy[] = [
  { name: 'dialog-incorrect-text', select: (root) =>
      matchDialogText(root, /not quite|try again|incorrect|not right/i) },
];

function matchDialogText(root: ParentNode, pattern: RegExp): Element | null {
  const dialogs = root.querySelectorAll('[role="dialog"]');
  for (const dialog of Array.from(dialogs)) {
    const text = dialog.textContent ?? '';
    // Skip the cookie-consent dialog, which is also role="dialog" [OBS].
    if (/cookie|privacy|隐私/i.test(text)) continue;
    if (pattern.test(text)) return dialog;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Derived signals
 * ------------------------------------------------------------------ */

export interface ProgressInfo {
  /** Zero-based question position within the exercise. */
  index: number;
  /** Total number of questions, when the page exposes it. */
  total: number | null;
  /** The site's own state word, e.g. "incomplete", "incorrect". */
  state: string;
  /** The raw testid, kept for diagnostics only. */
  raw: string;
}

/**
 * Read the progress marker.
 *
 * [VER] Critically, only the numeric index is used downstream. The state word
 * changes as soon as an answer is submitted, so including it in a question's
 * identity would make every submission look like a new question.
 */
export function readProgress(doc: ParentNode): ProgressInfo | null {
  const cells = Array.from(doc.querySelectorAll('[data-testid^="exercise-progress-"]'));
  if (cells.length === 0) return null;
  for (const cell of cells) {
    const raw = cell.getAttribute('data-testid') ?? '';
    if (!raw.endsWith('-current')) continue;
    const match = raw.match(/^exercise-progress-(\d+)-(.+?)(?:-current)?$/);
    if (!match) continue;
    return {
      index: Number(match[1]),
      total: cells.length,
      state: match[2] ?? 'unknown',
      raw,
    };  }
  return null;
}

/**
 * A locale-independent progress label such as "3 of 7" used as the question's
 * identity, so that two questions with similar stems are still distinguished
 * (spec 12.3).
 */
export function progressLabel(progress: ProgressInfo | null): string | null {
  if (!progress) return null;
  const total = progress.total ?? 0;
  return total > 0 ? `${progress.index + 1} of ${total}` : `#${progress.index + 1}`;
}

/** Exercise identifier from the page's own attribute, when present. */
export function readExerciseId(doc: ParentNode): string | null {
  // [OBS] `data-exercise-id="2002"` was present on the captured exercise page.
  const el = doc.querySelector('[data-exercise-id]');
  return el?.getAttribute('data-exercise-id') ?? null;
}

/**
 * Stable key for "which exercise/quiz is this", used to group records and to
 * key the resumable session.
 *
 * The URL shape is `/math/<course>/<unit>/<type>/<slug>` where <type> is one of
 * `e` (exercise), `quiz` or `test` [OBS]. When the page exposes a
 * `data-exercise-id` it is appended, which keeps the key stable if the slug is
 * edited on Khan Academy's side.
 */
export function exerciseKeyFromUrl(rawUrl: string, doc?: ParentNode): string {
  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    /* keep the raw string */
  }
  const trimmed = pathname.replace(/\/+$/, '');
  const match = trimmed.match(/^(.*\/(?:e|quiz|test)\/[^/]+)/);
  const base = match?.[1] ?? trimmed;
  const exerciseId = doc ? readExerciseId(doc) : null;
  return exerciseId ? `${base}#${exerciseId}` : base;
}

/* ------------------------------------------------------------------ *
 * End-of-exercise summary
 * ------------------------------------------------------------------ */

/**
 * The end-of-exercise summary screen ("Exercise complete! 4/4 correct").
 *
 * [VER] Detection is structural and was checked against every captured stage of
 * a full 4-question run: the summary is the ONLY state in which the question
 * form is gone while the exercise chrome is still present.
 *
 *     stage              answerform  progress  -> summary?
 *     q1..q4 answered    present     4 marks   -> false
 *     show summary       ABSENT      0 marks   -> true
 *
 * This is deliberately NOT keyed on the summary card's own testid, because that
 * testid (`eot-phantom-user-registration`) names the *logged-out* registration
 * prompt and is therefore not expected to exist for a signed-in learner. The
 * structural check holds either way.
 */
export function isSummaryPage(doc: ParentNode): boolean {
  if (doc.querySelector('form[name="answerform"]')) return false;
  if (doc.querySelectorAll('[data-testid^="exercise-progress-"]').length > 0) return false;
  return doc.querySelector('.bibliotron-exercise') !== null;
}

/**
 * Why the current question stopped being timed, or null if it should keep
 * running.
 *
 * Requirement 1 and 2 live here, in one testable place:
 *   - the page graded the answer CORRECT      -> the learner is done: stop
 *   - the page left "incomplete" after a Skip -> the skip was confirmed: stop
 *   - the page left "incomplete" any other way (a wrong answer) -> keep timing,
 *     because the learner is allowed to try again
 *
 * @param state          the progress state word now, e.g. "correct"
 * @param previous       the state word before, e.g. "incomplete"
 * @param skipInitiated  the Skip control was clicked and not cancelled
 */
export function completionTriggerFor(
  state: string,
  previous: string | null,
  skipInitiated: boolean,
): 'answered-correct' | 'skipped' | null {
  // Nothing moved: this is not a completion, whatever the flags say. The
  // detector only reports genuine transitions, but the guard keeps this rule
  // correct on its own terms.
  if (state === previous) return null;
  if (state === 'correct') return 'answered-correct';
  if (skipInitiated && previous === 'incomplete') return 'skipped';
  return null;
}

/**
 * Should the summary view be torn down?
 *
 * Leaving requires a POSITIVE signal, never merely the absence of the summary
 * marker. The transition INTO the summary is not atomic (the answer form is
 * removed before the progress markers are), and Khan Academy re-renders parts of
 * the summary while it is up. Treating any non-summary frame as "the learner
 * left" destroyed the injected card and cleared the run — and because that also
 * reset the "a question has been timed" latch, the card was then never
 * re-injected. Observed live as the summary card intermittently going missing.
 *
 * So: leave only when a question is genuinely on screen again (the learner
 * started another attempt) or the page moved somewhere else entirely.
 */
export function shouldLeaveSummary(input: {
  onSummary: boolean;
  questionFormPresent: boolean;
  urlChanged: boolean;
}): boolean {
  if (input.onSummary) return false;
  return input.questionFormPresent || input.urlChanged;
}

/**
 * Where to put the per-question timing card on the summary screen.
 *
 * `insert` says how to place the card relative to the host:
 *   'before-host' — immediately before the host, as its sibling. Used with the
 *                   exercise footer, which is the last thing in the content
 *                   column: the card therefore lands in normal flow BELOW every
 *                   piece of the page's own summary content and pushes the
 *                   footer down instead of covering it.
 *   'append'      — at the end of the host. The structural fallbacks.
 */
export interface SummaryHostStrategy extends SelectorStrategy {
  insert: 'before-host' | 'append';
}

export const SUMMARY_HOST: SummaryHostStrategy[] = [
  {
    // [OBS][MEASURED] Inserted BEFORE the exercise chrome's content area.
    //
    // This placement was chosen by measurement, not by reading class names.
    // The summary screen is a fixed-height app layout: the exercise chrome is
    // built from zero-height flex items whose content is absolutely positioned,
    // so almost every in-flow position paints over the results. Each candidate
    // was injected with a card-sized probe and the overlap with the exercise
    // panel's OWN text was counted (see references/observations.md §10.7):
    //
    //   before exercise-chrome-content      0 overlaps   (visible, y 503..713)
    //   append to exercise-chrome-content   0 overlaps   (below the fold)
    //   append to .bibliotron-exercise     10 overlaps
    //   append to content-panel-wrapper     9 overlaps
    //   before content-library-footer      12 overlaps
    //   after  content-panel-wrapper        9 overlaps
    //
    // The primary therefore shows none of the page's result information being
    // covered, AND lands inside the viewport so no scrolling is needed.
    // (The chrome's own content is pushed down inside its scrollable area.)
    name: 'before-exercise-chrome-content',
    select: first('[class*="exercise-chrome-content"]'),
    insert: 'before-host',
  },
  {
    // Fallback for a layout where the content area exists but is not a suitable
    // anchor: the end of that same scrollable area. Measured 0 overlaps too,
    // but sits below the fold.
    name: 'append-exercise-chrome-content',
    select: first('[class*="exercise-chrome-content"]'),
    insert: 'append',
  },
  {
    name: 'bibliotron-exercise',
    select: first('.bibliotron-exercise'),
    insert: 'append',
  },
  {
    name: 'content-panel-wrapper',
    select: first('[data-testid="content-panel-wrapper"]'),
    insert: 'append',
  },
];

/**
 * Decide the outcome of the learner's first submission.
 *
 * Prefers the structural progress state [VER]; falls back to the feedback
 * dialog's wording.
 */
export function readSubmissionOutcome(doc: ParentNode): FirstSubmissionOutcome {
  const progress = readProgress(doc);
  if (progress) {
    if (/incorrect/i.test(progress.state)) return 'incorrect';
    if (/correct/i.test(progress.state)) return 'correct';
  }
  return 'unknown';
}
