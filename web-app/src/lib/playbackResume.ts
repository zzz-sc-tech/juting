// 断点续听的位置值判定（纯函数，供单测直接覆盖）。
// 存储本体在 ExerciseProgress.lastPositionSec（随进度存档持久化），这里只回答
// 「这个位置值要不要信」：太靠前（刚开头）不值得续，太接近结尾（马上要重听）不续。

export const RESUME_MIN_SEC = 5
export const RESUME_TAIL_SEC = 15

/** 恢复判定：saved 有效且（在已知时长内）不落在结尾区，返回位置秒数，否则 null。 */
export const validResumePosition = (
  saved: number | undefined,
  duration: number,
): number | null => {
  if (!Number.isFinite(saved) || !saved || saved < RESUME_MIN_SEC) {
    return null
  }
  if (duration > 0 && saved > duration - RESUME_TAIL_SEC) {
    return null
  }
  return saved
}

/** 保存判定：位置有意义（≥1s）且还没播到头（ended 时走清除而不是保存）。 */
export const worthSaving = (positionSec: number, duration: number): boolean =>
  Number.isFinite(positionSec) &&
  positionSec >= 1 &&
  (duration <= 0 || positionSec < duration - 0.5)
