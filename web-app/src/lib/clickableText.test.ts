import { describe, expect, it } from 'vitest'
import { splitClickableWords } from './clickableText'

/**
 * 切词不能丢字符：拼回 parts 必须与原文逐字相等。
 * 连字符/撇号留词内（full-time / don't 是一个词），标点空白走 gap。
 */

const rebuild = (text: string) => splitClickableWords(text).map((p) => p.text).join('')

describe('splitClickableWords', () => {
  it('空串返回空数组', () => {
    expect(splitClickableWords('')).toEqual([])
  })

  it('纯标点整体是一个 gap', () => {
    expect(splitClickableWords('—— ... !!')).toEqual([{ type: 'gap', text: '—— ... !!' }])
  })

  it('普通句子：词与间隔交替，拼回原文一致', () => {
    const text = 'The quick brown fox.'
    const parts = splitClickableWords(text)
    expect(parts.map((p) => p.type)).toEqual(['word', 'gap', 'word', 'gap', 'word', 'gap', 'word', 'gap'])
    expect(rebuild(text)).toBe(text)
  })

  it('连字符留在词内（full-time 是一个词）', () => {
    const words = splitClickableWords('a full-time job').filter((p) => p.type === 'word').map((p) => p.text)
    expect(words).toContain('full-time')
  })

  it('撇号留在词内（don\'t 是一个词）', () => {
    const words = splitClickableWords("I don't know").filter((p) => p.type === 'word').map((p) => p.text)
    expect(words).toEqual(['I', "don't", 'know'])
  })

  it('弯撇号也留在词内（don’t 不能被拆成 don + t）', () => {
    const words = splitClickableWords('I don’t know').filter((p) => p.type === 'word').map((p) => p.text)
    expect(words).toEqual(['I', 'don’t', 'know'])
  })

  it('开头与结尾是标点时，首尾都有 gap', () => {
    const parts = splitClickableWords('"Hello!"')
    expect(parts[0]).toEqual({ type: 'gap', text: '"' })
    expect(parts[parts.length - 1]).toEqual({ type: 'gap', text: '!"' })
    expect(rebuild('"Hello!"')).toBe('"Hello!"')
  })

  it('连续空格与中文混排不丢字符', () => {
    const text = '他 说：  "OK   then."'
    expect(rebuild(text)).toBe(text)
  })

  it('数字开头的片段：数字进 gap，字母仍可点，字符不丢', () => {
    const text = '3D movie 2024.'
    expect(rebuild(text)).toBe(text)
    expect(splitClickableWords(text).filter((p) => p.type === 'word').map((p) => p.text)).toEqual(['D', 'movie'])
  })

  it('纯数字/符号不产生可点词', () => {
    expect(splitClickableWords('123 456 -- 78').every((p) => p.type === 'gap')).toBe(true)
  })
})
