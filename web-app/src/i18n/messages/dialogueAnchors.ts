import type { UiLocale } from '@juting/domain'

// DialogueAnchorBar.tsx 对话锚点条的文案。key 统一使用 `anchors.` 前缀。
// 锚点本身（第8–11题 / 对话 2 等）来自音频指令句，不翻译，按原文展示。
export const dialogueAnchorMessages: Record<UiLocale, Record<string, string>> = {
  'zh-CN': {
    'topbar.admin': '管理后台',
    'transcript.introSection': '开场',
    'transcript.groupSentences': '{{count}} 句',
    'transcript.announcementOnly': '仅播报',
    'anchors.barLabel': '对话锚点',
    'anchors.jumpTooltip': '跳转到 {{label}}',
  },
  'en-US': {
    'topbar.admin': 'Admin console',
    'transcript.introSection': 'Intro',
    'transcript.groupSentences': '{{count}} sentences',
    'transcript.announcementOnly': 'Announcement only',
    'anchors.barLabel': 'Dialogue anchors',
    'anchors.jumpTooltip': 'Jump to {{label}}',
  },
  'th-TH': {
    'topbar.admin': 'แผงผู้ดูแล',
    'transcript.introSection': 'เปิด',
    'transcript.groupSentences': '{{count}} ประโยค',
    'transcript.announcementOnly': 'ประกาศเท่านั้น',
    'anchors.barLabel': 'หมุดบทสนทนา',
    'anchors.jumpTooltip': 'ข้ามไปที่ {{label}}',
  },
  'ja-JP': {
    'topbar.admin': '管理コンソール',
    'transcript.introSection': 'オープニング',
    'transcript.groupSentences': '{{count}} 文',
    'transcript.announcementOnly': '放送のみ',
    'anchors.barLabel': 'ダイアログアンカー',
    'anchors.jumpTooltip': '{{label}} に移動',
  },
  'fr-FR': {
    'topbar.admin': 'Console admin',
    'transcript.introSection': 'Intro',
    'transcript.groupSentences': '{{count}} phrases',
    'transcript.announcementOnly': 'Annonce uniquement',
    'anchors.barLabel': 'Ancres de dialogue',
    'anchors.jumpTooltip': 'Aller à {{label}}',
  },
  'es-ES': {
    'topbar.admin': 'Consola de administración',
    'transcript.introSection': 'Intro',
    'transcript.groupSentences': '{{count}} frases',
    'transcript.announcementOnly': 'Solo anuncio',
    'anchors.barLabel': 'Anclas de diálogo',
    'anchors.jumpTooltip': 'Ir a {{label}}',
  },
}
