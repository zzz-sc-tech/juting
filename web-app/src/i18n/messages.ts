import { appMessages } from './messages/app'
import { coreMessages } from './messages/core'
import { courseMapMessages } from './messages/courseMap'
import { dashboardMessages } from './messages/dashboard'
import { difficultReviewMessages } from './messages/difficultReview'
import { dialogueAnchorMessages } from './messages/dialogueAnchors'
import { drillMessages } from './messages/drill'
import { examStageMessages } from './messages/examStage'
import { extensiveStageMessages } from './messages/extensiveStage'
import { globalReviewMessages } from './messages/globalReview'
import { intensiveStageMessages } from './messages/intensiveStage'
import { searchMessages } from './messages/search'
import { settingsMessages } from './messages/settings'
import { storageMessages } from './messages/storage'
import { stageMessages } from './messages/studyStages'
import { studyStatesMessages } from './messages/studyStates'
import { vocabMessages } from './messages/vocab'
import { waveformStageMessages } from './messages/waveformStage'

// 单语（简体中文）文案表：各模块维护在 messages/ 下（每模块一张扁平键表，
// key 以模块名做前缀），这里合并成一张总表供 useLanguage().t(key) 查询。
const messages = {
  ...appMessages,
  ...coreMessages,
  ...courseMapMessages,
  ...dashboardMessages,
  ...difficultReviewMessages,
  ...dialogueAnchorMessages,
  ...drillMessages,
  ...examStageMessages,
  ...extensiveStageMessages,
  ...globalReviewMessages,
  ...intensiveStageMessages,
  ...searchMessages,
  ...settingsMessages,
  ...storageMessages,
  ...stageMessages,
  ...studyStatesMessages,
  ...vocabMessages,
  ...waveformStageMessages,
}

export type MessageKey = keyof typeof messages

export { messages }
