/**
 * Simplified Chinese catalog.
 *
 * Typed as `Record<MessageKey, string>` against the English source catalog, so
 * a key added to `en.ts` fails `pnpm typecheck` here until it is translated:
 * a missing translation can never reach the UI as an empty label.
 *
 * Placeholders, `{name}`, must match the English template — and so must the
 * `_one` / `_other` plural siblings. Chinese selects `other` for every count
 * (see `Intl.PluralRules('zh-CN')`), so the two variants hold the same text;
 * they are both written out because the type demands full coverage, which also
 * documents to a translator that the key is count-dependent.
 *
 * The strings here are the extension's original Chinese labels, kept verbatim
 * so an existing Chinese user sees no change at all.
 */
import type { MessageKey } from './en.js';

export const zhCN: Record<MessageKey, string> = {
  /* ---------------- shared vocabulary ---------------- */
  'app.timerTitle': '题目计时',
  'mode.countup': '正计时',
  'mode.countdown': '倒计时',

  /* ---------------- floating panel ---------------- */
  'overlay.collapse': '折叠面板',
  'overlay.expand': '展开面板',
  'overlay.pause': '暂停',
  'overlay.resume': '继续',
  'overlay.finished': '已完成',
  'overlay.statusFinished': '已完成',
  'overlay.statusPaused': '已暂停',
  'overlay.reset': '重置本题',
  'overlay.metaLimit': '限时',
  'overlay.metaOverrun': '超时',
  'overlay.metaProgress': '进度',
  'overlay.metaConfidence': '识别：{level}',
  'overlay.savedRecords': '已记录 {count}',
  'overlay.confidenceStableId': '题目ID',
  'overlay.confidenceFingerprint': '指纹',
  'overlay.confidenceWeak': '弱信号',
  'overlay.confidenceNone': '未识别',

  /* ---------------- end-of-exercise summary card ---------------- */
  'summary.title': '本轮每题用时',
  'summary.expand': '展开用时明细',
  'summary.collapse': '折叠用时明细',
  'summary.totalAll_one': '共 {count} 题 · 合计 {total}',
  'summary.totalAll_other': '共 {count} 题 · 合计 {total}',
  'summary.totalPartial_one': '共 {count} 题 · {timed} 题有数据 · 合计 {total}',
  'summary.totalPartial_other': '共 {count} 题 · {timed} 题有数据 · 合计 {total}',
  'summary.noData': '暂无数据',
  'summary.empty': '本轮没有记录到题目用时。请确认在答题时悬浮面板处于显示状态。',
  'summary.tagSkipped': '已跳过',
  'summary.tagTimedOut': '超时',
  'summary.tagCorrect': '答对',
  'summary.tagIncorrect': '答错',
  'summary.tagMissing': '数据缺失',
  'summary.tagBonus': '加试',
  'summary.questionNumber': '第 {number} 题',
  'summary.paused': '暂停 {duration}',
  'summary.colQuestion': '题目',
  'summary.colDuration': '用时',
  'summary.storageNote': '用时数据只保存在本机浏览器中，不会上传到任何服务器。',

  /* ---------------- panel footer / popup status: detector events ---------------- */
  'event.initializing': '正在初始化…',
  'event.noQuestionPosition': '尚未开始计时：页面还没有报出这是第几题',
  'event.sameQuestion': '题目未变化，计时继续',
  'event.identityUpgraded': '题目已按进度重新识别，计时继续',
  'event.pendingChange': '检测到可能的题目变化，等待确认…',
  'event.uncertain': '识别不确定，本题计时已暂停',
  'event.unidentifiedPaused': '未识别到题目，本题计时已暂停',
  'event.identityRestored': '已重新识别到本题，继续计时',
  'event.resumed': '已恢复上次的计时',
  'event.started': '检测到新题目，计时开始',
  'event.skipped': '已跳过，本题计时已停止',
  'event.answeredCorrect': '答对，本题计时已停止',
  'event.switchedSaved': '已切到别的练习，上一题用时已保存',
  'event.switchedParked': '已切到别的练习，本题计时已暂存',
  'event.resumedManual': '已继续计时',
  'event.pausedManual': '已暂停计时',
  'event.reset': '已重置本题计时',
  'event.summaryShown': '本轮已完成，已显示每题用时',
  'event.summaryNoHost': '本轮已完成，但未找到可插入用时的位置',
  'event.newAttempt': '检测到新一轮答题',
  'event.countdownEndedTone': '倒计时结束，已提示',
  'event.countdownEndedToneBlocked': '倒计时结束（提示音被浏览器阻止）',
  'event.countdownEnded': '倒计时结束',
  'event.firstSubmission': '已记录第一次提交时间',
  'event.firstSubmissionCorrect': '第一次提交：正确',
  'event.firstSubmissionIncorrect': '第一次提交：错误（已记录时间戳）',
  'event.skipClicked': '已点击跳过，等待确认…',
  'event.modeCountdown': '已切换为倒计时',
  'event.modeCountup': '已切换为正计时',

  /* ---------------- panel warnings ---------------- */
  'warning.uncertainPaused':
    '无法可靠识别当前题目（{reason}）。本题计时已暂停，重新识别到本题后会自动继续。',
  'warning.uncertainHidden':
    '未识别到题目（{reason}）。面板已隐藏，识别到题目后会自动开始计时。',
  'warning.weakSignal':
    '题目识别仅依赖弱信号（进度标记），可能无法自动检测切题。请使用"重置本题"。',

  /* ---------------- popup: status card ---------------- */
  'popup.statusLabel': '当前状态',
  'popup.statusLoading': '读取中…',
  'popup.overTime': '已超时',
  'popup.detailStrategy': '识别方式',
  'popup.detailConfidence': '置信度',
  'popup.detailQuestionKey': '题目指纹',
  'popup.detailProgress': '题目进度',
  'popup.detailLastEvent': '最近事件',
  'popup.diagnosticsSummary': '诊断信息',
  'popup.noTimerHere': '此标签页未运行计时器',
  'popup.statusUnreadable': '无法读取页面状态',
  'popup.statusReadFailed': '读取失败：{message}',
  'popup.notStarted': '尚未开始：请点击页面上的「Let’s go」',
  'popup.pausedForUnidentified': '未识别到题目：本题计时已暂停，重新识别到本题后自动继续',
  'popup.regionMissing': '未找到题目区域',
  'popup.regionOnly': '已找到题目区域，但无法识别题目',
  'popup.lowConfidence': '识别置信度较低',
  'popup.timing': '正在计时',
  'popup.expiredTag': '已超时 +{duration}',
  'popup.confidenceStableId': '题目 ID（强）',
  'popup.confidenceFingerprint': '题目指纹（中）',
  'popup.confidenceWeak': '弱信号',
  'popup.confidenceNone': '未识别',
  'popup.initFailed': '面板初始化失败：{message}',
  'popup.diagPractice': '练习标识:',
  'popup.diagQuestionKey': '题目键:',
  'popup.diagRegionFound': '区域已找到:',
  'popup.diagStrategy': '选择器策略:',
  'popup.diagMatchedRecords': '匹配记录:',
  'popup.diagProblems': '问题记录:',
  'popup.diagNone': '（无）',

  /* ---------------- popup: settings card ---------------- */
  'popup.settingsHeading': '设置',
  'popup.settingLanguage': '语言',
  'popup.languageAuto': '跟随浏览器',
  'popup.settingDefaultMode': '默认计时模式',
  'popup.modeCountupOption': '正计时（记录用时）',
  'popup.modeCountdownOption': '倒计时（每题限时）',
  'popup.settingLimit': '每题限时（秒）',
  'popup.settingSound': '倒计时归零时播放提示音',
  'popup.settingOverlayVisible': '在页面上显示悬浮面板',
  'popup.settingOverlayCollapsed': '面板默认折叠为小胶囊',
  'popup.settingResume': '关闭页面后重新打开时，继续上次用时',
  'popup.settingDeveloperMode': '开发者模式',
  'popup.saveFailed': '保存失败：浏览器存储不可用',

  /* ---------------- popup: history card ---------------- */
  'popup.recordsHeading': '历史记录',
  'popup.savedCount_one': '已保存 {count} 条',
  'popup.savedCount_other': '已保存 {count} 条',
  'popup.clearRecords': '清除全部记录',
  'popup.recordsEmpty': '暂无记录。在可汗学院练习页完成一道题后会出现在这里。',
  'popup.recordTimedOut': '超时',
  'popup.recordFirstIncorrect': '首次答错',
  'popup.recordFirstCorrect': '首次答对',
  'popup.recordSubmitted': '已提交',
  'popup.recordPartial': '未完成',
  'popup.recordPosition': '{number}/{total} 题',
  'popup.recordPositionOnly': '第 {number} 题',
  'popup.shortKeyId': 'ID {key}',
  'popup.shortKeyFingerprint': '指纹 {key}',
  'popup.cleared': '记录已清除',
  'popup.clearFailed': '清除失败：浏览器存储不可用',
};
