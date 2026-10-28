import { describe, expect, it } from 'vitest'
import {
  RESUME_MIN_SEC,
  RESUME_TAIL_SEC,
  validResumePosition,
  worthSaving,
} from './playbackResume'

describe('validResumePosition', () => {
  it('开头不值得续（< RESUME_MIN_SEC）', () => {
    expect(validResumePosition(undefined, 0)).toBeNull()
    expect(validResumePosition(0, 1200)).toBeNull()
    expect(validResumePosition(RESUME_MIN_SEC - 0.5, 1200)).toBeNull()
  })

  it('正常位置原样返回', () => {
    expect(validResumePosition(RESUME_MIN_SEC, 1200)).toBe(RESUME_MIN_SEC)
    expect(validResumePosition(734.5, 1800)).toBe(734.5)
    // 时长未知（元数据未就绪）时只做下限校验
    expect(validResumePosition(734.5, 0)).toBe(734.5)
  })

  it('太接近结尾不续（马上就要重听了）', () => {
    const duration = 1800
    expect(validResumePosition(duration - RESUME_TAIL_SEC - 1, duration)).toBe(
      duration - RESUME_TAIL_SEC - 1,
    )
    expect(validResumePosition(duration - RESUME_TAIL_SEC + 5, duration)).toBeNull()
    expect(validResumePosition(duration, duration)).toBeNull()
  })

  it('非法值拒绝', () => {
    expect(validResumePosition(Number.NaN, 1200)).toBeNull()
    expect(validResumePosition(Number.POSITIVE_INFINITY, 1200)).toBeNull()
  })
})

describe('worthSaving', () => {
  it('≥1s 且未到结尾才保存', () => {
    expect(worthSaving(0, 1200)).toBe(false)
    expect(worthSaving(0.5, 1200)).toBe(false)
    expect(worthSaving(1, 1200)).toBe(true)
    expect(worthSaving(1199.9, 1200)).toBe(false)
    expect(worthSaving(600, 1200)).toBe(true)
    // 时长未知时不做结尾判断
    expect(worthSaving(600, 0)).toBe(true)
    expect(worthSaving(Number.NaN, 1200)).toBe(false)
  })
})
