// 生成听写判定用的全库词表（唯一词形，小写）
// 用法：node scripts/content/gen-dictation-vocab.mjs
// 数据源：presets/cet6/seed.json 的全部 transcript_json 文本。
// seed 更新后重跑本脚本（词表是构建产物，进 git）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const seed = JSON.parse(fs.readFileSync(path.join(root, 'presets/cet6/seed.json'), 'utf8'))

const vocab = new Set()
for (const ex of seed.exercises) {
  for (const line of ex.transcript_json) {
    for (const w of line.text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) {
      vocab.add(w)
    }
  }
}
const sorted = [...vocab].sort()
const out = `// 自动生成（scripts/content/gen-dictation-vocab.mjs）——勿手改；seed 更新后重跑。
// 全库 38 课转写的唯一词形（小写），供听写判定的「错拼是否成词」检查：
// 编辑距离宽容只适用于不在本表中的错拼（enviroment），防止 though/through
// 这类双方都是真词的混淆对被误判为拼写（见 lib/dictation.ts judge）。
export const DICTATION_CORPUS: readonly string[] = [
${sorted.map((w) => `  ${JSON.stringify(w)},`).join('\n')}
]
`
const target = path.join(root, 'web-app/src/lib/generated/dictationVocab.ts')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, out, 'utf8')
console.log(`generated ${sorted.length} words -> ${path.relative(root, target)}`)
