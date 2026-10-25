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

// Shared context-budget helper for always-on appendSystemPrompt sections.
// Asset descriptions are authored for asset pages and tool manifests, not for
// per-request prompt space; sections that enumerate mounted assets keep each
// entry to a capped first sentence and point at the discovery tools
// (asset_show / workflow_query / tool descriptions) for the full text.

export const PROMPT_SUMMARY_MAX_CHARS = 160

// Hard entry cap for always-on prompt sections that enumerate mounted assets
// (knowledge/data, tools, workflows, delegated roles). Per-entry text is
// already capped, but the COUNT grew with the asset packs — an uncapped map
// turns pack growth directly into system-prompt growth. Entries beyond the
// cap stay reachable through the discovery tools.
export const PROMPT_ENUMERATION_MAX_ENTRIES = 200

/** Standard trailer line for enumerations truncated by the entry cap. */
export function promptEnumerationOmittedLine(
  omitted: number,
  discoveryHint: string,
): string {
  return `… ${omitted} more entries omitted; use ${discoveryHint} to discover them.`
}

/**
 * Collapse whitespace and cap a description to its first sentence (ASCII or
 * CJK sentence boundary), hard-limited to `maxChars` with an ellipsis.
 */
export function capPromptSummary(
  text: string,
  maxChars = PROMPT_SUMMARY_MAX_CHARS,
): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const boundaries: number[] = []
  const cjkMatch = collapsed.match(/[。！？]/)
  if (cjkMatch?.index !== undefined) {
    boundaries.push(cjkMatch.index + 1)
  }
  const asciiMatch = collapsed.match(/\.(?=\s|$)/)
  if (asciiMatch?.index !== undefined) {
    boundaries.push(asciiMatch.index + 1)
  }
  let sentence =
    boundaries.length > 0
      ? collapsed.slice(0, Math.min(...boundaries)).trim()
      : collapsed
  if (sentence.length > maxChars) {
    sentence = sentence.slice(0, maxChars - 1).trimEnd() + '…'
  }
  return sentence
}
