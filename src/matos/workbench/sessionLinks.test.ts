import { describe, expect, test } from 'bun:test'
import { stableProjectChatSessionIds } from './sessionLinks.js'

describe('MatOS project chat session identity', () => {
  test('survives role asset upgrades while separating members and roles', () => {
    const base = {
      projectId: 'project-a',
      conversationId: 'main',
      roleRef: 'role:compute@1.0.0',
      memberId: 'agent-compute',
    }
    const first = stableProjectChatSessionIds(base)
    expect(stableProjectChatSessionIds({
      ...base,
      roleRef: 'role:compute@2.0.0',
    })).toEqual(first)
    expect(stableProjectChatSessionIds({
      ...base,
      roleRef: 'role:academic@1.0.0',
    })).not.toEqual(first)
    expect(stableProjectChatSessionIds({
      ...base,
      memberId: 'agent-compute-2',
    })).not.toEqual(first)
  })
})
