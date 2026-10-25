import type { MatOSAssetHistoryScope } from '../assets/history/index.js'

export type MatOSDirectAssetEditorScope = Extract<
  MatOSAssetHistoryScope,
  'core' | 'project' | 'user' | 'team'
>
