// 错题清单页（/wrong）的文案。key 统一使用 `wrongBook.` 前缀。
export const wrongBookMessages = {
    'wrongBook.title': '错题清单',
    'wrongBook.subtitle': '跨课汇总的反复错题——考过两场以上，或同一题错过两次。点一行去实战重做那一题。',
    'wrongBook.summary': '共 {{count}} 题 · 覆盖 {{courses}} 门课',
    'wrongBook.loading': '正在读取课程…',
    'wrongBook.loadFailed': '课程列表加载失败，本地成绩档案不受影响',
    'wrongBook.retry': '重试',
    'wrongBook.empty': '还没有反复错的题——保持！',
    'wrongBook.emptyHint': '在实战里考过两场以上，或同一题错过两次，才会进这份清单。',
    'wrongBook.sectionA': 'Section A · 新闻报道',
    'wrongBook.sectionB': 'Section B · 长对话',
    'wrongBook.sectionC': 'Section C · 篇章听力',
    'wrongBook.sectionCount': '{{count}} 题',
    'wrongBook.meta': '错 {{wrong}} 次 / 考过 {{attempts}} 场',
    'wrongBook.last': '最近 {{date}}',
    'wrongBook.action': '去重做',
} as const
