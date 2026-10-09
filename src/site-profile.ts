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
