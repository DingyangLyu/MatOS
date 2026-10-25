/** Shared MatOS product-feedback DTOs used by the web, daemon, and `od` CLI. */

export const FEEDBACK_ISSUE_STATUSES = [
  'open',
  'triaged',
  'in_progress',
  'resolved',
  'closed',
  'rejected',
] as const;

export type FeedbackIssueStatus = (typeof FEEDBACK_ISSUE_STATUSES)[number];
export type FeedbackIssueKind = 'bug' | 'suggestion';
export type FeedbackIssueSeverity = 'low' | 'normal' | 'high' | 'blocking';

export interface FeedbackIssueAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface FeedbackIssue {
  id: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  status: FeedbackIssueStatus;
  kind: FeedbackIssueKind;
  severity: FeedbackIssueSeverity;
  title: string;
  message: string;
  messagePreview: string;
  contact: string;
  context: Record<string, string>;
  attachments: FeedbackIssueAttachment[];
  /** Full details only in the trusted administrator daemon; title-only otherwise. */
  viewerAccess: 'full' | 'title';
}

export interface FeedbackIssueSummary {
  total: number;
  fixedTotal: number;
  statusCounts: Partial<Record<FeedbackIssueStatus, number>>;
  /** UTC ISO date -> number of issues moved to resolved/closed that day. */
  resolvedDaily: Record<string, number>;
}

export interface FeedbackIssueListResponse {
  issues: FeedbackIssue[];
  summary: FeedbackIssueSummary;
}
