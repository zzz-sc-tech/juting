// 存储故障横幅（StorageAlertBanner）与设置页存储诊断区的文案。
export const storageMessages = {
    'storage.quota': '本地存储已满，最新进度没有保存。请立即导出备份，再清理浏览器数据。',
    'storage.quotaAction': '去导出备份',
    'storage.unavailable': '本地存储不可用（可能是隐私模式或被浏览器禁用），本次学习记录不会保存。',
    'storage.corrupt': '检测到本地学习数据损坏，原始数据已隔离保留，暂不写盘以免覆盖。',
    'storage.corruptPartial': '有 {{count}} 门课程的进度损坏，已隔离保留原始数据，其余进度不受影响。',
    'storage.corruptAction': '去处理',
    // 设置页 · 存储诊断
    'settings.storage.title': '存储诊断',
    'settings.storage.ok': '本地存储读写正常，未发现损坏数据。',
    'settings.storage.blocked': '进度写盘已暂停：损坏的原始数据尚未处理，继续写会把它覆盖掉。',
    'settings.storage.dropped': '已跳过 {{count}} 门损坏的课程进度（原始数据已隔离保留）。',
    'settings.storage.copyCount': '已保留 {{count}} 份损坏数据副本。',
    'settings.storage.downloadCopies': '下载损坏数据副本',
    'settings.storage.resume': '忽略损坏数据，恢复写盘',
    'settings.storage.resumeHint': '恢复后新进度会正常保存；损坏那部分已在上面的副本里，不会被真正丢掉。',
    // 设置页 · 自动快照
    'settings.storage.snapshotTitle': '从自动快照恢复',
    'settings.storage.snapshotHint': '每次启动与每 10 分钟自动存一份进度快照（保留最近 2 份），误清数据时可回到上一份。',
    'settings.storage.snapshotEmpty': '暂无可用的自动快照。',
    'settings.storage.snapshotItem': '{{time}} · {{courses}} 门课 / {{lines}} 句 / 已掌握 {{mastered}}',
    'settings.storage.snapshotRestore': '恢复这一份',
    'settings.storage.snapshotConfirm': '将用这份快照覆盖当前进度与学习日历，确定继续？',
    'settings.storage.snapshotDone': '已恢复，页面即将刷新…',
    'settings.storage.snapshotFailed': '恢复失败：快照已不可用或存储写入失败。',
}
