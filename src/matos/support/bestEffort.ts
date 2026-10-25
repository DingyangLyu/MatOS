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

import { recordMatOSSwallowed } from './crashCapture.js'

/**
 * Observable replacement for `.catch(() => undefined)` on state-mutating
 * best-effort work (the code-health audit found ~129 silently swallowed
 * rejections; the worst ones swallowed durable-write failures on optimizer
 * failure paths and asset rollback paths).
 *
 * Semantics are identical to the swallow it replaces: the work is awaited,
 * failures never propagate, and `undefined` is returned on failure. The only
 * difference is that each swallow is recorded to the MatOS crash/ops channel
 * as a `kind: "swallowed"` record (sampled to at most one record per label
 * per minute), so silent state divergence stays diagnosable.
 */
export async function bestEffort<T>(
  label: string,
  work: Promise<T> | (() => Promise<T> | T),
): Promise<T | undefined> {
  try {
    return await (typeof work === 'function' ? work() : work)
  } catch (error) {
    recordMatOSSwallowed(label, error)
    return undefined
  }
}
