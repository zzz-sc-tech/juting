// App.tsx 会话编排外壳的文案。key 统一使用 `app.` 前缀。
// app.chapterBanner.progress 的 {{current}}/{{total}} 为章节序号占位符，
// 运行时由 t() 插值替换（如 "第 3 章 / 共 12 章"）。
export const appMessages = {
    'app.studyArea.aria': '课程学习区',
    'app.chapterBanner.aria': '当前章节',
    'app.chapterBanner.kicker': '当前章节',
    'app.chapterBanner.seriesFallback': '当前系列',
    'app.chapterBanner.progress': '第 {{current}} 章 / 共 {{total}} 章',
}
