// DifficultReviewStage.tsx 难点复习阶段的文案。key 统一使用 `review.` 前缀。
// 译文优先复用 LanguageProvider.tsx 中 legacyTranslationCatalogs 的既有翻译；
// mediaControlsLabel 与 spaceShortcut 为旧机制未覆盖的新增翻译。
export const difficultReviewMessages = {
    'review.emptyTitle': '暂无难点',
    'review.backToIntensive': '回到逐句学习',
    'review.transcriptHint': '先听一遍，或按 R 显示原文',
    'review.mediaControlsLabel': '难点逐句播放',
    'review.previousTooltip': '上一句',
    'review.previous': '上句',
    'review.pause': '暂停',
    'review.play': '播放',
    'review.playLineTooltip': '播放本句',
    'review.spaceShortcut': '空格',
    'review.nextTooltip': '下一句',
    'review.next': '下句',
    'review.removeDifficult': '移出难点',
    'review.sentenceListTitle': '难点句子',
    'review.conquer': '已掌握，移出难点',
    'review.orderLabel': '复习顺序',
    'review.orderWeakest': '最弱优先',
    'review.orderOriginal': '原序',
    'review.orderRandom': '随机',
}
