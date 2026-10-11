/**
 * 精听 → 波形的 A-B 循环交接：精听卡「去波形循环」把当前句塞进这里，
 * WaveformStage 就绪后取走并直接进入循环态（一次性，取后即清）。
 */
export type WaveLoopHandoff = {
  exerciseId: number
  start: number
  end: number
}

let pending: WaveLoopHandoff | null = null

export const setPendingWaveLoop = (handoff: WaveLoopHandoff): void => {
  pending = handoff
}

export const takePendingWaveLoop = (): WaveLoopHandoff | null => {
  const taken = pending
  pending = null
  return taken
}
