import type { UiLocale } from '@juting/domain'
import { appMessages } from './messages/app'
import { coreMessages } from './messages/core'
import { courseMapMessages } from './messages/courseMap'
import { dashboardMessages } from './messages/dashboard'
import { difficultReviewMessages } from './messages/difficultReview'
import { dialogueAnchorMessages } from './messages/dialogueAnchors'
import { extensiveStageMessages } from './messages/extensiveStage'
import { intensiveStageMessages } from './messages/intensiveStage'
import { settingsMessages } from './messages/settings'
import { stageMessages } from './messages/studyStages'
import { studyStatesMessages } from './messages/studyStates'
import { waveformStageMessages } from './messages/waveformStage'

// 各模块维护自己的消息表（web-app/src/i18n/messages/*.ts），这里按语言合并成
// 一张扁平表供 useLanguage().t(key) 查询。key 以模块名做前缀避免冲突。
const modules: Record<UiLocale, Record<string, string>>[] = [
  appMessages,
  coreMessages,
  courseMapMessages,
  dashboardMessages,
  difficultReviewMessages,
  dialogueAnchorMessages,
  extensiveStageMessages,
  intensiveStageMessages,
  settingsMessages,
  stageMessages,
  studyStatesMessages,
  waveformStageMessages,
]

const mergeLocale = (locale: UiLocale): Record<string, string> =>
  Object.assign({}, ...modules.map((table) => table[locale]))

export const messages: Record<UiLocale, Record<string, string>> = {
  'zh-CN': mergeLocale('zh-CN'),
  'en-US': mergeLocale('en-US'),
  'th-TH': mergeLocale('th-TH'),
  'ja-JP': mergeLocale('ja-JP'),
  'fr-FR': mergeLocale('fr-FR'),
  'es-ES': mergeLocale('es-ES'),
}

export type MessageKey = string
