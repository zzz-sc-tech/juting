// 学习阶段导航文案（StageRail 显示用）。stageCopy（domain）里的中文仅作兜底，
// 界面文案一律走这里的 i18n key：stage.<id>.title / .metric。
export const stageMessages = {
  'zh-CN': {
    'stage.extensive.title': '泛听热身',
    'stage.intensive.title': '逐句学习',
    'stage.waveform.title': '波形自由听',
    'stage.review.title': '难点复习',
  },
  'en-US': {
    'stage.extensive.title': 'Extensive warm-up',
    'stage.intensive.title': 'Sentence drill',
    'stage.waveform.title': 'Free waveform',
    'stage.review.title': 'Weak-spot review',
  },
  'th-TH': {
    'stage.extensive.title': 'ฟังแบบกว้าง',
    'stage.intensive.title': 'เรียนทีละประโยค',
    'stage.waveform.title': 'ฟรีเวฟฟอร์ม',
    'stage.review.title': 'ทบทวนจุดยาก',
  },
  'ja-JP': {
    'stage.extensive.title': '通聴ウォームアップ',
    'stage.intensive.title': '一文ずつ学習',
    'stage.waveform.title': '波形フリーリスニング',
    'stage.review.title': '弱点復習',
  },
  'fr-FR': {
    'stage.extensive.title': 'Écoute globale',
    'stage.intensive.title': 'Étude phrase par phrase',
    'stage.waveform.title': 'Écoute libre (onde)',
    'stage.review.title': 'Révision des points faibles',
  },
  'es-ES': {
    'stage.extensive.title': 'Calentamiento de escucha',
    'stage.intensive.title': 'Estudio frase a frase',
    'stage.waveform.title': 'Escucha libre (onda)',
    'stage.review.title': 'Repaso de puntos débiles',
  },
} as const
