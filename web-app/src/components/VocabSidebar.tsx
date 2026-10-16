import { Check, Plus, X } from 'lucide-react'
import { useMemo } from 'react'
import { useLanguage } from '../i18n/LanguageProvider'
import type { MessageKey } from '../i18n/messages'
import { hasVocabContextFailed, useVocabContextLines } from '../lib/vocabContext'
import { lookupVocab } from '../lib/vocabDict'

/** ECDICT tag → 文案键（生成脚本只输出这几种，取优先级最高的一个） */
const TAG_MESSAGE_KEYS = {
  cet6: 'vocab.tag.cet6',
  ky: 'vocab.tag.ky',
  cet4: 'vocab.tag.cet4',
  toefl: 'vocab.tag.toefl',
  ielts: 'vocab.tag.ielts',
  gk: 'vocab.tag.gk',
  zk: 'vocab.tag.zk',
  gre: 'vocab.tag.gre',
} as const satisfies Record<string, MessageKey>

type VocabTag = keyof typeof TAG_MESSAGE_KEYS

type VocabSidebarProps = {
  /** 点中的词形（原样展示，保留原文大小写与撇号） */
  word: string
  /** 是否已在生词本 */
  saved: boolean
  onClose: () => void
  onAdd: (word: string) => void
  onRemove: (word: string) => void
  /** 跳到例句所在的课与句 */
  onJumpToLine: (courseId: number, lineId: string) => void
  /** courseId → 课标题，用于例句来源标注 */
  courseTitles?: Record<number, string>
  /** 本地已有的行文本 courseId → lineId → text，省一次请求 */
  localLines?: Record<number, Record<string, string>>
}

/**
 * 点词查词典的右侧滑出侧栏。
 *
 * 数据来自生成的精简词典（lib/vocabDict → generated/vocabDict）：只收本库
 * 38 课出现过的词，音标/词性/中文释义/考试标签齐全，例句用本库真实语境。
 * 未收录的词（专有名词、合成词）也要能打开、能收藏，只是释义区降级显示。
 */
export function VocabSidebar({
  word,
  saved,
  onClose,
  onAdd,
  onRemove,
  onJumpToLine,
  courseTitles,
  localLines,
}: VocabSidebarProps) {
  const { t } = useLanguage()
  const entry = useMemo(() => lookupVocab(word), [word])
  const ctx = entry?.ctx
  const texts = useVocabContextLines(ctx, localLines)
  // 点到的词形与词条头词不一致时（点的是变形词），标出词条头词
  const headword = entry && entry.w !== word.toLowerCase() ? entry.w : null

  return (
    <>
      <div className="vocab-sidebar-mask" onClick={onClose} />
      <aside
        aria-label={t('vocab.sidebarAria')}
        className="vocab-sidebar"
        role="dialog"
      >
        <header className="vocab-sidebar-head">
          <div className="vocab-sidebar-title">
            <strong className="vocab-sidebar-word">{word}</strong>
            {headword && <span className="vocab-sidebar-headword">{headword}</span>}
          </div>
          <button
            aria-label={t('vocab.close')}
            autoFocus
            className="vocab-sidebar-close"
            onClick={onClose}
            type="button"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {entry ? (
          <div className="vocab-sidebar-body">
            <div className="vocab-sidebar-meta">
              {entry.ph && <span className="vocab-sidebar-phonetic">/{entry.ph}/</span>}
              {entry.pos && <span className="vocab-sidebar-pos">{entry.pos}</span>}
              {entry.tag && entry.tag in TAG_MESSAGE_KEYS && (
                <span className={`vocab-tag vocab-tag-${entry.tag}`}>
                  {t(TAG_MESSAGE_KEYS[entry.tag as VocabTag])}
                </span>
              )}
            </div>
            <p className="vocab-sidebar-zh">{entry.zh}</p>

            {ctx && ctx.length > 0 && (
              <section className="vocab-sidebar-examples">
                <h2 className="vocab-sidebar-examples-title">{t('vocab.examples')}</h2>
                <ul>
                  {ctx.map(([courseId, lineId]) => {
                    const key = `${courseId}:${lineId}`
                    const text = texts[key]
                    const failedFetch = !text && hasVocabContextFailed(courseId)
                    return (
                      <li className="vocab-ctx-row" key={key}>
                        <button
                          className="vocab-ctx-jump"
                          onClick={() => onJumpToLine(courseId, lineId)}
                          title={t('vocab.jumpToLine')}
                          type="button"
                        >
                          {courseTitles?.[courseId] ?? `#${courseId}`}
                        </button>
                        <p
                          className={
                            text ? 'vocab-ctx-text' : 'vocab-ctx-text pending'
                          }
                        >
                          {text ??
                            (failedFetch ? t('vocab.exampleFailed') : t('vocab.exampleLoading'))}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
          </div>
        ) : (
          <div className="vocab-sidebar-body">
            <p className="vocab-sidebar-missing">{t('vocab.notInDict')}</p>
            <p className="vocab-sidebar-missing-hint">{t('vocab.notInDictHint')}</p>
          </div>
        )}

        <footer className="vocab-sidebar-foot">
          {saved ? (
            <button
              className="vocab-sidebar-action saved"
              onClick={() => onRemove(word)}
              type="button"
            >
              <Check size={15} aria-hidden="true" />
              {t('vocab.remove')}
            </button>
          ) : (
            <button
              className="vocab-sidebar-action"
              onClick={() => onAdd(word)}
              type="button"
            >
              <Plus size={15} aria-hidden="true" />
              {t('vocab.addToVocab')}
            </button>
          )}
        </footer>
      </aside>
    </>
  )
}