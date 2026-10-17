import { defineConfig } from 'vitest/config'

/**
 * 只测纯函数：node 环境即可，不引 jsdom / testing-library。
 * 组件测试成本高、维护重，而纯函数（进度合并、复习调度、错题聚合、切词）
 * 覆盖了本项目绝大多数回归风险。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
