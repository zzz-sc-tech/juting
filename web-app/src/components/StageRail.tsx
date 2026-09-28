import type { ComponentType, SVGProps } from 'react'
import { useLanguage } from '../i18n/LanguageProvider'

export type StageRailItem<TStage extends string> = {
  id: TStage
  title: string
  /** 工具类阶段（如波形自由听）：不编号、不占学习步骤序号。 */
  tool?: boolean
  Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
}

type StageRailProps<TStage extends string> = {
  activeStage: TStage
  completedStages: Partial<Record<TStage, boolean>>
  stages: StageRailItem<TStage>[]
  onStageSelect: (stage: TStage) => void
}

export function StageRail<TStage extends string>({
  activeStage,
  completedStages,
  stages,
  onStageSelect,
}: StageRailProps<TStage>) {
  const { t } = useLanguage()
  // 学习步骤从 1 计数；工具类阶段不占号，后续步骤的序号继续衔接。
  let stepNumber = 0
  return (
    <div className="stage-rail duo-rail" aria-label={t('stageRail.label')}>
      {stages.map((stage) => {
        const active = activeStage === stage.id
        const completed = completedStages[stage.id]
        const Icon = stage.Icon
        const step = stage.tool ? null : ++stepNumber
        return (
          <button
            className={[
              'stage-step',
              active ? 'active' : '',
              completed ? 'completed' : '',
              stage.tool ? 'tool' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={stage.id}
            onClick={() => onStageSelect(stage.id)}
            type="button"
          >
            {step !== null && <span className="stage-number">{step}</span>}
            <Icon size={20} aria-hidden="true" />
            <span>
              <span className="stage-label">
                <strong>{stage.title}</strong>
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
