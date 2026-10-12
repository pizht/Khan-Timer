/**
 * English message catalog — the SOURCE OF TRUTH for the message keys.
 *
 * Why English is the source: the extension's primary audience is English
 * speaking, and English is also the fallback language, so every key must exist
 * here before it can exist anywhere else. `MessageKey` is derived from this
 * object, and every other catalog is typed as `Record<MessageKey, string>` —
 * which turns a missing or mistyped translation into a compile error instead of
 * a blank label in the UI.
 *
 * Placeholders are written `{name}` and interpolated by `t()`. A key that needs
 * plural agreement is split into `_one` / `_other` siblings and selected by
 * `Intl.PluralRules` when `t()` is called with a numeric `count` (see
 * `index.ts`); a language with different plural categories adds its own
 * suffixes there (`_few`, `_many`, …) without touching the call sites.
 *
 * Copy rules: keep the strings short enough for the 232px floating panel, use
 * typographic quotes, and never put markup in a message — `t()` returns plain
 * text and the call sites escape it where they build HTML.
 */
export const en = {
  /* ---------------- shared vocabulary ---------------- */
  /** The panel's header and the popup's heading. */
  'app.timerTitle': 'Question timer',
  'mode.countup': 'Count up',
  'mode.countdown': 'Countdown',

  /* ---------------- floating panel ---------------- */
  'overlay.collapse': 'Collapse panel',
  'overlay.expand': 'Expand panel',
  'overlay.pause': 'Pause',
  'overlay.resume': 'Resume',
  /** Pause button label once the question is finished (the button is disabled). */
  'overlay.finished': 'Done',
  /** Badge drawn after the readout by `.status-finished .readout::after`. */
  'overlay.statusFinished': 'Done',
  /** Badge drawn after the readout by `.status-paused .readout::after`. */
  'overlay.statusPaused': 'Paused',
  'overlay.reset': 'Reset question',
  'overlay.metaLimit': 'Limit',
  'overlay.metaOverrun': 'Over',
  'overlay.metaProgress': 'Progress',
  'overlay.metaConfidence': 'Detection: {level}',
  'overlay.savedRecords': 'Saved: {count}',
  'overlay.confidenceStableId': 'ID',
  'overlay.confidenceFingerprint': 'fingerprint',
  'overlay.confidenceWeak': 'weak signal',
  'overlay.confidenceNone': 'unidentified',

  /* ---------------- end-of-exercise summary card ---------------- */
  'summary.title': 'Time per question in this attempt',
  'summary.expand': 'Expand per-question times',
  'summary.collapse': 'Collapse per-question times',
  'summary.totalAll_one': '{count} question · {total} total',
  'summary.totalAll_other': '{count} questions · {total} total',
  'summary.totalPartial_one': '{count} question · {timed} with data · {total} total',
  'summary.totalPartial_other': '{count} questions · {timed} with data · {total} total',
  'summary.noData': 'No data yet',
  'summary.empty':
    'No question times were recorded for this attempt. Check that the floating panel was visible while you were answering.',
  'summary.tagSkipped': 'Skipped',
  'summary.tagTimedOut': 'Over time',
  'summary.tagCorrect': 'Correct',
  'summary.tagIncorrect': 'Incorrect',
  'summary.tagMissing': 'No data',
  'summary.tagBonus': 'Bonus',
  'summary.questionNumber': 'Question {number}',
  'summary.paused': 'Paused {duration}',
  'summary.colQuestion': 'Question',
  'summary.colDuration': 'Time',
  'summary.storageNote':
    'Timing data is kept in this browser only and is never uploaded to any server.',

  /* ---------------- panel footer / popup status: detector events ---------------- */
  'event.initializing': 'Starting…',
  'event.noQuestionPosition': 'Not timing yet: the page has not said which question this is',
  'event.sameQuestion': 'Same question, timing continues',
  'event.identityUpgraded': 'Question re-identified by progress, timing continues',
  'event.pendingChange': 'Possible question change detected, confirming…',
  'event.uncertain': 'Detection uncertain, this question is paused',
  'event.unidentifiedPaused': 'No question identified, this question is paused',
  'event.identityRestored': 'Question identified again, timing continues',
  'event.resumed': 'Resumed the previous timing',
  'event.started': 'New question detected, timing started',
  'event.skipped': 'Skipped, timing for this question stopped',
  'event.answeredCorrect': 'Correct, timing for this question stopped',
  'event.switchedSaved': 'Switched to another practice, the previous question was saved',
  'event.switchedParked': 'Switched to another practice, this question is parked',
  'event.resumedManual': 'Timing resumed',
  'event.pausedManual': 'Timing paused',
  'event.reset': 'This question was reset',
  'event.summaryShown': 'Attempt complete, per-question times shown',
  'event.summaryNoHost': 'Attempt complete, but no place to insert the times was found',
  'event.newAttempt': 'A new attempt was detected',
  'event.countdownEndedTone': 'Countdown finished, tone played',
  'event.countdownEndedToneBlocked': 'Countdown finished (the browser blocked the tone)',
  'event.countdownEnded': 'Countdown finished',
  'event.firstSubmission': 'First submission time recorded',
  'event.firstSubmissionCorrect': 'First submission: correct',
  'event.firstSubmissionIncorrect': 'First submission: incorrect (timestamp recorded)',
  'event.skipClicked': 'Skip clicked, confirming…',
  'event.modeCountdown': 'Switched to countdown',
  'event.modeCountup': 'Switched to count up',

  /* ---------------- panel warnings ---------------- */
  'warning.uncertainPaused':
    'Cannot reliably identify the current question ({reason}). Timing for this question is paused and resumes automatically once it is identified again.',
  'warning.uncertainHidden':
    'No question identified ({reason}). The panel is hidden and timing starts automatically once a question is identified.',
  'warning.weakSignal':
    'Question detection relies on a weak signal (the progress marker) only, so question changes may not be detected automatically. Use “Reset question” if needed.',

  /* ---------------- popup: status card ---------------- */
  'popup.statusLabel': 'Status',
  'popup.statusLoading': 'Reading…',
  'popup.overTime': 'Over time',
  'popup.detailStrategy': 'Detection',
  'popup.detailConfidence': 'Confidence',
  'popup.detailQuestionKey': 'Question key',
  'popup.detailProgress': 'Question progress',
  'popup.detailLastEvent': 'Last event',
  'popup.diagnosticsSummary': 'Diagnostics',
  'popup.noTimerHere': 'No timer is running in this tab',
  'popup.statusUnreadable': 'Cannot read the page status',
  'popup.statusReadFailed': 'Read failed: {message}',
  'popup.notStarted': 'Not started yet: press “Let’s go” on the page',
  'popup.pausedForUnidentified':
    'No question identified: this question is paused and resumes automatically once it is identified again',
  'popup.regionMissing': 'No question area found',
  'popup.regionOnly': 'A question area was found, but the question cannot be identified',
  'popup.lowConfidence': 'Detection confidence is low',
  'popup.timing': 'Timing',
  'popup.expiredTag': 'Over by {duration}',
  'popup.confidenceStableId': 'Question ID (strong)',
  'popup.confidenceFingerprint': 'Question fingerprint (medium)',
  'popup.confidenceWeak': 'Weak signal',
  'popup.confidenceNone': 'Unidentified',
  'popup.initFailed': 'The panel failed to initialise: {message}',
  'popup.diagPractice': 'Practice:',
  'popup.diagQuestionKey': 'Question key:',
  'popup.diagRegionFound': 'Region found:',
  'popup.diagStrategy': 'Selector strategy:',
  'popup.diagMatchedRecords': 'Matched records:',
  'popup.diagProblems': 'Problems:',
  'popup.diagNone': '(none)',

  /* ---------------- popup: settings card ---------------- */
  'popup.settingsHeading': 'Settings',
  'popup.settingLanguage': 'Language',
  'popup.languageAuto': 'Automatic (browser language)',
  'popup.settingDefaultMode': 'Default timer mode',
  'popup.modeCountupOption': 'Count up (record time spent)',
  'popup.modeCountdownOption': 'Countdown (limit per question)',
  'popup.settingLimit': 'Time limit per question (seconds)',
  'popup.settingSound': 'Play a tone when the countdown reaches zero',
  'popup.settingOverlayVisible': 'Show the floating panel on the page',
  'popup.settingOverlayCollapsed': 'Start the panel collapsed as a small pill',
  'popup.settingResume': 'Resume the previous time when the page is reopened',
  'popup.settingDeveloperMode': 'Developer mode',
  'popup.saveFailed': 'Save failed: browser storage is unavailable',

  /* ---------------- popup: history card ---------------- */
  'popup.recordsHeading': 'History',
  'popup.savedCount_one': '{count} record saved',
  'popup.savedCount_other': '{count} records saved',
  'popup.clearRecords': 'Clear all records',
  'popup.recordsEmpty':
    'No records yet. Finish a question on a Khan Academy exercise and it will show up here.',
  'popup.recordTimedOut': 'Over time',
  'popup.recordFirstIncorrect': 'First try wrong',
  'popup.recordFirstCorrect': 'First try correct',
  'popup.recordSubmitted': 'Submitted',
  'popup.recordPartial': 'Unfinished',
  'popup.shortKeyId': 'ID {key}',
  'popup.shortKeyFingerprint': 'FP {key}',
  'popup.cleared': 'Records cleared',
  'popup.clearFailed': 'Clear failed: browser storage is unavailable',
} as const;

/** Every message key this extension can render. */
export type MessageKey = keyof typeof en;
