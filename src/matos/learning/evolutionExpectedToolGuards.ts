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

import type { MatOSEvent } from '../sessions/eventTypes.js'
import { matOSEmbeddedToolErrorKindFromText } from './toolErrorKind.js'

const EXPECTED_TOOL_GUARD_ERROR_KINDS = new Set([
  'active_task_collision',
])

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Accepts the base event shape: guard classification only reads type/data,
// so plain MatOSEvent callers (e.g. classifySelfEvolutionTrigger) and
// MatOSEventSource callers are both valid.
//
// Preference order: the structured `data.errorKind` recorded at the
// tool-execution source (see toolErrorKind.ts) wins when present; the rendered
// text scan below is the legacy fallback for records written before the
// structured field existed, and its behavior is intentionally unchanged.
export function matOSExpectedToolGuardErrorKind(
  event: MatOSEvent,
): string | undefined {
  const direct = nonEmptyString(event.data.errorKind)
  if (direct) {
    return direct
  }
  for (const value of [
    event.data.resultPreview,
    event.data.outputPreview,
    event.data.error,
    event.data.errorMessage,
  ]) {
    const text = nonEmptyString(value)
    if (!text) {
      continue
    }
    const embedded = matOSEmbeddedToolErrorKindFromText(text)
    if (embedded) {
      return embedded
    }
  }
  return undefined
}

export function isMatOSExpectedToolGuardEvent(
  event: MatOSEvent,
): boolean {
  const errorKind = matOSExpectedToolGuardErrorKind(event)
  return Boolean(errorKind && EXPECTED_TOOL_GUARD_ERROR_KINDS.has(errorKind))
}
