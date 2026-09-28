import type { UiLocale } from '@juting/domain'

// ExtensiveStage.tsx 泛听阶段与 TranscriptPanel.tsx 字幕面板的文案。
// key 分别使用 `extensive.` 与 `transcript.` 前缀。
export const extensiveStageMessages: Record<UiLocale, Record<string, string>> = {
  'zh-CN': {
    'extensive.play': '开始',
    'extensive.pause': '暂停',
    'extensive.playbackProgress': '播放进度',
    'extensive.skipToSentenceStudy': '跳到逐句学习',
    'transcript.panelTitle': '章节句子',
    'transcript.hiddenLineChallenge': '遮罩模式',
    'transcript.selectedLineHint': '字幕在上方',
  },
  'en-US': {
    'extensive.play': 'Play',
    'extensive.pause': 'Pause',
    'extensive.playbackProgress': 'Playback progress',
    'extensive.skipToSentenceStudy': 'Skip to sentence study',
    'transcript.panelTitle': 'Chapter sentences',
    'transcript.hiddenLineChallenge': 'Mask mode',
    'transcript.selectedLineHint': 'Subtitle above',
  },
  'th-TH': {
    'extensive.play': 'เล่น',
    'extensive.pause': 'หยุดชั่วคราว',
    'extensive.playbackProgress': 'ความคืบหน้าการเล่น',
    'extensive.skipToSentenceStudy': 'ข้ามไปเรียนทีละประโยค',
    'transcript.panelTitle': 'ประโยคในบทเรียน',
    'transcript.hiddenLineChallenge': 'โหมดซ่อนคำบรรยาย',
    'transcript.selectedLineHint': 'คำบรรยายอยู่ด้านบน',
  },
  'ja-JP': {
    'extensive.play': '再生',
    'extensive.pause': '一時停止',
    'extensive.playbackProgress': '再生の進捗',
    'extensive.skipToSentenceStudy': '文ごとの学習へスキップ',
    'transcript.panelTitle': 'チャプターの文',
    'transcript.hiddenLineChallenge': 'マスクモード',
    'transcript.selectedLineHint': '字幕は上に表示',
  },
  "fr-FR": {
    "extensive.play": "Lire",
    "extensive.pause": "Pause",
    "extensive.playbackProgress": "Progression de la lecture",
    "extensive.skipToSentenceStudy": "Passer à l’étude phrase par phrase",
    "transcript.panelTitle": "Phrases du chapitre",
    'transcript.hiddenLineChallenge': 'Mode masqué',
    'transcript.selectedLineHint': 'Sous-titre ci-dessus',
},
  "es-ES": {
    "extensive.play": "Reproducir",
    "extensive.pause": "Pausa",
    "extensive.playbackProgress": "Progreso de reproducción",
    "extensive.skipToSentenceStudy": "Pasar al estudio por frases",
    "transcript.panelTitle": "Frases del capítulo",
    'transcript.hiddenLineChallenge': 'Modo de máscara',
    'transcript.selectedLineHint': 'Subtítulo arriba',
},
}
