/**
 * DeepSeek model catalog for web model pickers (`matos workbench models list
 * --json`). `id: null` is the configured default; other ids are valid
 * `--model` values for a MatOS run.
 */
export type MatOSWorkbenchModelOption = {
  /** `--model` value; null means "configured default" (omit the flag). */
  id: string | null
  label: string
  description: string
  isDefault: boolean
}

export type MatOSWorkbenchModelsView = {
  models: MatOSWorkbenchModelOption[]
  generatedAt: string
}

const DEEPSEEK_MODELS: ReadonlyArray<Omit<MatOSWorkbenchModelOption, 'isDefault'>> = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash', description: 'Fast general model' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Stronger reasoning model' },
]

export async function listMatOSWorkbenchModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MatOSWorkbenchModelsView> {
  const configured = env.MATOS_DSH_MODEL?.trim() || env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash'
  const models: MatOSWorkbenchModelOption[] = [
    { id: null, label: 'Default', description: `Configured default (${configured})`, isDefault: true },
    ...DEEPSEEK_MODELS.map(model => ({ ...model, isDefault: false })),
  ]
  if (!DEEPSEEK_MODELS.some(model => model.id === configured)) {
    models.push({ id: configured, label: configured, description: 'Configured model', isDefault: false })
  }
  return { models, generatedAt: new Date().toISOString() }
}
