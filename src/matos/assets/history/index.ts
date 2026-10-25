/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { git } from './gitBackend.js'
import {
  listMatOSAssetHistoryReleases,
  listMatOSAssetHistoryReleasesWithIssues,
  listMatOSAssetHistoryRecordIssues,
  listMatOSAssetHistorySnapshots,
  listMatOSAssetHistorySnapshotsWithIssues,
  readMatOSAssetHistoryRelease,
  readMatOSAssetHistorySnapshot,
  writeMatOSAssetHistoryReleaseRecord,
} from './records.js'
import {
  createMatOSAssetHistorySnapshot,
  hasMatOSAssetHistoryWorkingTreeChanges,
  listMatOSAssetHistoryWorkingTreeChangedFiles,
} from './snapshot.js'
import { restoreMatOSAssetHistorySnapshot } from './restore.js'
import { validateMatOSAssetHistorySnapshot } from './validation.js'
import {
  assetHistoryLockPath,
  withMatOSAssetHistoryLock,
} from './lock.js'
import type { MatOSAssetHistoryDiff } from './types.js'

export {
  createMatOSAssetHistorySnapshot,
  hasMatOSAssetHistoryWorkingTreeChanges,
  listMatOSAssetHistoryWorkingTreeChangedFiles,
  listMatOSAssetHistoryReleases,
  listMatOSAssetHistoryReleasesWithIssues,
  listMatOSAssetHistoryRecordIssues,
  listMatOSAssetHistorySnapshots,
  listMatOSAssetHistorySnapshotsWithIssues,
  readMatOSAssetHistoryRelease,
  readMatOSAssetHistorySnapshot,
  restoreMatOSAssetHistorySnapshot,
  validateMatOSAssetHistorySnapshot,
  writeMatOSAssetHistoryReleaseRecord,
  assetHistoryLockPath,
  withMatOSAssetHistoryLock,
}
export * from './types.js'
export * from './refs.js'
export * from './releaseService.js'

async function resolveCommit(cwd: string, value: string): Promise<string> {
  const snapshot = await readMatOSAssetHistorySnapshot(cwd, value)
  return snapshot?.commit ?? value
}

export async function diffMatOSAssetHistorySnapshots(input: {
  cwd: string
  from: string
  to: string
}): Promise<MatOSAssetHistoryDiff> {
  const fromCommit = await resolveCommit(input.cwd, input.from)
  const toCommit = await resolveCommit(input.cwd, input.to)
  const patch = await git(input.cwd, ['diff', '--binary', fromCommit, toCommit])
  return {
    from: input.from,
    to: input.to,
    fromCommit,
    toCommit,
    patch,
  }
}
