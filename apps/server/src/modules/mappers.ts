import type {
  AttributionDto,
  IdeaMergeDto,
  IdeaStatus,
  IdeaSummaryDto,
  ReviewDecision,
  ReviewDto,
  ScopeFeature,
  ScopeVersionDto,
  ScopeVersionStatus,
  SubmissionDto,
  SubmissionFields,
  SubmissionRelation,
  SubmissionSource,
  ParseStatus,
} from '@workbench/contracts';
import { missingFields } from './submissions/template.ts';

export interface SubmissionRow {
  id: string;
  seq: string;
  source: SubmissionSource;
  source_message_id: string | null;
  author_name: string | null;
  raw_text: string;
  received_at: Date;
  parse_status: ParseStatus;
  fields: SubmissionFields;
  idea_id: string;
  relation: SubmissionRelation;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface IdeaRow {
  id: string;
  seq: string;
  title: string;
  status: IdeaStatus;
  merged_into_id: string | null;
  current_scope_version_id: string | null;
  approved_scope_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScopeVersionRow {
  id: string;
  idea_id: string;
  version_no: number;
  features: ScopeFeature[];
  page_scope: string;
  style: string | null;
  notes: string | null;
  status: ScopeVersionStatus;
  proposed_by: string;
  created_at: Date;
  status_changed_at: Date;
}

export function toSubmissionDto(r: SubmissionRow): SubmissionDto {
  return {
    id: r.id,
    source: r.source,
    isSimulated: r.source !== 'douyin',
    sourceMessageId: r.source_message_id,
    authorName: r.author_name,
    rawText: r.raw_text,
    receivedAt: r.received_at.toISOString(),
    parseStatus: r.parse_status,
    fields: r.fields,
    missingFields: missingFields(r.fields),
    ideaId: r.idea_id,
    relation: r.relation,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export function toScopeVersionDto(r: ScopeVersionRow): ScopeVersionDto {
  return {
    id: r.id,
    ideaId: r.idea_id,
    versionNo: r.version_no,
    features: r.features as ScopeVersionDto['features'],
    pageScope: r.page_scope,
    style: r.style,
    notes: r.notes,
    status: r.status,
    proposedBy: r.proposed_by,
    createdAt: r.created_at.toISOString(),
    statusChangedAt: r.status_changed_at.toISOString(),
  };
}

export function toReviewDto(r: {
  id: string;
  idea_id: string;
  scope_version_id: string | null;
  decision: ReviewDecision;
  reason: string | null;
  reviewer: string;
  created_at: Date;
}): ReviewDto {
  return {
    id: r.id,
    ideaId: r.idea_id,
    scopeVersionId: r.scope_version_id,
    decision: r.decision,
    reason: r.reason,
    reviewer: r.reviewer,
    createdAt: r.created_at.toISOString(),
  };
}

export function toMergeDto(r: {
  id: string;
  source_idea_id: string;
  target_idea_id: string;
  reason: string;
  actor: string;
  created_at: Date;
}): IdeaMergeDto {
  return {
    id: r.id,
    sourceIdeaId: r.source_idea_id,
    targetIdeaId: r.target_idea_id,
    reason: r.reason,
    actor: r.actor,
    createdAt: r.created_at.toISOString(),
  };
}

export function toAttributionDto(r: {
  id: string;
  submission_id: string;
  from_idea_id: string;
  to_idea_id: string;
  from_relation: SubmissionRelation;
  to_relation: SubmissionRelation;
  reason: string;
  actor: string;
  merge_id: string | null;
  created_at: Date;
}): AttributionDto {
  return {
    id: r.id,
    submissionId: r.submission_id,
    fromIdeaId: r.from_idea_id,
    toIdeaId: r.to_idea_id,
    fromRelation: r.from_relation,
    toRelation: r.to_relation,
    reason: r.reason,
    actor: r.actor,
    mergeId: r.merge_id,
    createdAt: r.created_at.toISOString(),
  };
}

export type IdeaSummaryRow = IdeaRow & {
  submission_count: number;
  feedback_count: number;
  has_simulated: boolean;
};

export function toIdeaSummaryDto(r: IdeaSummaryRow): IdeaSummaryDto {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    mergedIntoId: r.merged_into_id,
    currentScopeVersionId: r.current_scope_version_id,
    approvedScopeVersionId: r.approved_scope_version_id,
    submissionCount: r.submission_count,
    feedbackCount: r.feedback_count,
    hasSimulatedSubmissions: r.has_simulated,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
