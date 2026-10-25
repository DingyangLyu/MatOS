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

// Tiny real-process fixture for crashCapture.test.ts: installs crash capture
// exactly like a MatOS entrypoint would, then dies through the requested
// failure mode. The test asserts that a redacted crash record landed in
// $MATOS_OPS_DIR/crashes/crashes.jsonl and that the process still died the
// default way (nonzero exit).

import {
  installMatOSCrashCapture,
  recordMatOSFatalExit,
} from './crashCapture.js'

installMatOSCrashCapture({
  component: 'crash-fixture',
  ...(process.env.CRASH_FIXTURE_RECENT_LOG
    ? { recentLogPath: process.env.CRASH_FIXTURE_RECENT_LOG }
    : {}),
})

const mode = process.argv[2] ?? 'throw'
const secret = process.env.MATOS_FAKE_PROVIDER_TOKEN ?? 'no-secret-set'

if (mode === 'rejection') {
  setTimeout(() => {
    void Promise.reject(
      new Error(`fixture-rejection with secret ${secret} embedded`),
    )
  }, 5)
} else if (mode === 'fatal-exit') {
  recordMatOSFatalExit({
    component: 'crash-fixture',
    error: new Error(`fixture-fatal-exit with secret ${secret} embedded`),
  })
  process.exit(3)
} else {
  setTimeout(() => {
    throw new Error(`fixture-throw with secret ${secret} embedded`)
  }, 5)
}
