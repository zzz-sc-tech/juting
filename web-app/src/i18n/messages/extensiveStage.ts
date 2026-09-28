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
    'transcript.hiddenLineChallenge': '隐藏字幕挑战',
    'transcript.selectedLineHint': '本句字幕显示在上方',
  },
  'en-US': {
    'extensive.play': 'Play',
    'extensive.pause': 'Pause',
    'extensive.playbackProgress': 'Playback progress',
    'extensive.skipToSentenceStudy': 'Skip to sentence study',
    'transcript.panelTitle': 'Chapter sentences',
    'transcript.hiddenLineChallenge': 'Hidden transcript challenge',
    'transcript.selectedLineHint': 'Subtitle shown above',
  },
  'th-TH': {
    'extensive.play': 'เล่น',
    'extensive.pause': 'หยุดชั่วคราว',
    'extensive.playbackProgress': 'ความคืบหน้าการเล่น',
    'extensive.skipToSentenceStudy': 'ข้ามไปเรียนทีละประโยค',
    'transcript.panelTitle': 'ประโยคในบทเรียน',
    'transcript.hiddenLineChallenge': 'ท้าทายคำบรรยายที่ซ่อนอยู่',
    'transcript.selectedLineHint': 'คำบรรยายแสดงด้านบน',
  },
  'ja-JP': {
    'extensive.play': '再生',
    'extensive.pause': '一時停止',
    'extensive.playbackProgress': '再生の進捗',
    'extensive.skipToSentenceStudy': '文ごとの学習へスキップ',
    'transcript.panelTitle': 'チャプターの文',
    'transcript.hiddenLineChallenge': '字幕非表示チャレンジ',
    'transcript.selectedLineHint': '字幕は上に表示中',
  },
  "fr-FR": {
    "extensive.play": "Lire",
    "extensive.pause": "Pause",
    "extensive.playbackProgress": "Progression de la lecture",
    "extensive.skipToSentenceStudy": "Passer à l’étude phrase par phrase",
    "transcript.panelTitle": "Phrases du chapitre",
    "transcript.hiddenLineChallenge": "Défi sans transcription",
    "transcript.selectedLineHint": "Sous-titre affiché ci-dessus"
},
  "es-ES": {
    "extensive.play": "Reproducir",
    "extensive.pause": "Pausa",
    "extensive.playbackProgress": "Progreso de reproducción",
    "extensive.skipToSentenceStudy": "Pasar al estudio por frases",
    "transcript.panelTitle": "Frases del capítulo",
    "transcript.hiddenLineChallenge": "Reto sin transcripción",
    "transcript.selectedLineHint": "Subtítulo mostrado arriba"
},
}
