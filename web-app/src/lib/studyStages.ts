import { AudioWaveform, Brain, CircleHelp, Headphones } from 'lucide-react'
import type { StageRailItem } from '../components/StageRail'
import {
  isDictationAccepted,
  normalizeText,
  stageCopy as sharedStageCopy,
  type StudyStage,
} from '@juting/domain'

export type { StudyStage }

export const stageCopy: Record<
  StudyStage,
  Omit<StageRailItem<StudyStage>, 'id'>
> = {
  extensive: {
    ...sharedStageCopy.extensive,
    Icon: Headphones,
  },
  intensive: {
    ...sharedStageCopy.intensive,
    Icon: Brain,
  },
  waveform: {
    ...sharedStageCopy.waveform,
    Icon: AudioWaveform,
  },
  review: {
    ...sharedStageCopy.review,
    Icon: CircleHelp,
  },
}

export { isDictationAccepted, normalizeText }
