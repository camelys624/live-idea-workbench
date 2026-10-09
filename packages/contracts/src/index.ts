/**
 * 直播创意工作台 前后端共享 API 契约。
 *
 * 约定：
 * - 所有接口前缀 `/api`，JSON，时间为 ISO-8601 字符串，ID 为 UUID。
 * - 请求体由本文件的 zod schema 校验（服务端强制，前端可复用做表单校验）。
 * - 失败统一返回 `ApiErrorBody`，`code` 取自 `ERROR_CODES`。
 * - 身份由可信代理注入（见 server README），前端不传递身份或执行凭据。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/**
 * 投稿来源。
 * - manual：人工录入（主播/协作者照抄或转录的真实投稿）
 * - sample：示例数据，仅用于开发演示，前端必须明确标记
 * - douyin：真实抖音评论推送，只能由获准后的接入模块写入，人工接口不可伪造
 */
export const SUBMISSION_SOURCES = ['manual', 'sample', 'douyin'] as const;
export type SubmissionSource = (typeof SUBMISSION_SOURCES)[number];
export const MANUAL_ENTRY_SOURCES = ['manual', 'sample'] as const;
export type ManualEntrySource = (typeof MANUAL_ENTRY_SOURCES)[number];

/** 原文按投稿模板解析的结果；与之后的人工整理无关。 */
export const PARSE_STATUSES = ['complete', 'partial', 'unparsed'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

/**
 * 投稿与创意的关系。
 * - origin：创建该创意的首条投稿
 * - duplicate：重复创意，经人工合并归入
 * - feedback：补充反馈/多条补充，归入既有创意或产品，不改变本次范围
 */
export const SUBMISSION_RELATIONS = ['origin', 'duplicate', 'feedback'] as const;
export type SubmissionRelation = (typeof SUBMISSION_RELATIONS)[number];
export const REATTRIBUTE_RELATIONS = ['duplicate', 'feedback'] as const;

/**
 * 创意状态。
 * - open：尚无待审范围
 * - pending_review：最新范围版本待人工审核
 * - returned：最新范围被退回补充，可重新提交范围
 * - approved：最新范围已人工批准（唯一可进入立项的状态）
 * - rejected：已拒绝，不立项
 * - merged：已作为重复创意合并到其他创意
 */
export const IDEA_STATUSES = ['open', 'pending_review', 'returned', 'approved', 'rejected', 'merged'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** 范围版本状态。版本内容不可修改；修改范围 = 新建版本，旧的待审/批准版本变为 superseded。 */
export const SCOPE_VERSION_STATUSES = ['pending_review', 'approved', 'returned', 'rejected', 'superseded'] as const;
export type ScopeVersionStatus = (typeof SCOPE_VERSION_STATUSES)[number];

export const REVIEW_DECISIONS = ['approve', 'return', 'reject'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * 角色。
 * - operator：录入投稿、整理字段、合并/归属、提交范围版本
 * - reviewer：审核（批准/退回/拒绝）
 * 立项、分配、启动权限属于后续 Multica 模块，不在此列。
 */
export const ROLES = ['operator', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/** 模板字段键名，与投稿模板一一对应。 */
export const TEMPLATE_FIELDS = [
  'title', // 想做啥
  'targetUsers', // 给谁用
  'problem', // 解决啥问题
  'desiredFeatures', // 希望它能干啥（全部期望功能）
  'viewerPriorities', // 最希望先做哪3件事（观众优先项）
  'pageScope', // 想要几个页面、分别放啥
  'completionCriteria', // 做到啥样算完成
  'style', // 喜欢啥风格（选填）
] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];
/** 除选填的 style 外均为必填；缺失时 missingFields 列出。 */
export const REQUIRED_TEMPLATE_FIELDS = TEMPLATE_FIELDS.filter((f) => f !== 'style');

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_STATE', // 当前状态不允许该操作
  'STALE_SCOPE_VERSION', // 提交/审核基于的范围版本已不是最新
  'MERGE_INVALID', // 合并/归属目标非法（自身、已合并、已拒绝等）
  'USE_IDEA_MERGE', // 不能单独移走创意的最后一条投稿，应改用创意合并
  'NOT_LAUNCHABLE', // 未批准或批准已失效，不可立项
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

// ---------------------------------------------------------------------------
// 请求 schema
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => text(max).nullable();

/** 投稿整理字段。所有字段可空：投稿可能不完整，缺失项由 missingFields 体现。 */
export const SubmissionFieldsSchema = z.object({
  title: nullableText(200),
  targetUsers: nullableText(1000),
  problem: nullableText(2000),
  desiredFeatures: z.array(text(500)).max(100),
  /** 观众自己写的优先项，数量按原文保留（可能不是 3 个），不等于本次最终范围。 */
  viewerPriorities: z.array(text(500)).max(20),
  pageScope: nullableText(2000),
  completionCriteria: nullableText(2000),
  style: nullableText(500),
});
export type SubmissionFields = z.infer<typeof SubmissionFieldsSchema>;

/**
 * POST /api/submissions — 人工录入或示例投稿。
 * rawText 原样保存且不可修改；服务端按模板解析，`fields` 中给出的键覆盖解析结果。
 * 带 sourceMessageId 时按 (source, sourceMessageId) 消息级去重：重复提交返回已有投稿（200，deduplicated=true）。
 */
export const CreateSubmissionSchema = z.object({
  source: z.enum(MANUAL_ENTRY_SOURCES),
  rawText: text(5000),
  authorName: nullableText(100).optional(),
  sourceMessageId: nullableText(200).optional(),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  fields: SubmissionFieldsSchema.partial().optional(),
});
export type CreateSubmissionRequest = z.infer<typeof CreateSubmissionSchema>;

/** PATCH /api/submissions/:id/fields — 人工整理字段（原文不变）。至少一个键。 */
export const UpdateSubmissionFieldsSchema = SubmissionFieldsSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: '至少提供一个字段' },
);
export type UpdateSubmissionFieldsRequest = z.infer<typeof UpdateSubmissionFieldsSchema>;

/** POST /api/submissions/:id/reattribute — 把单条投稿作为重复或补充反馈归入另一创意。 */
export const ReattributeSubmissionSchema = z.object({
  targetIdeaId: z.uuid(),
  relation: z.enum(REATTRIBUTE_RELATIONS),
  reason: text(1000),
});
export type ReattributeSubmissionRequest = z.infer<typeof ReattributeSubmissionSchema>;

/** POST /api/ideas/:id/merge — 把本创意作为重复创意整体合并到目标创意。 */
export const MergeIdeaSchema = z.object({
  targetIdeaId: z.uuid(),
  reason: text(1000),
});
export type MergeIdeaRequest = z.infer<typeof MergeIdeaSchema>;

export const ScopeFeatureSchema = z.object({
  title: text(200),
  /** 该功能的完成标准，必填。 */
  acceptanceCriteria: text(2000),
});
export type ScopeFeature = z.infer<typeof ScopeFeatureSchema>;

/**
 * POST /api/ideas/:id/scope-versions — 提交本次范围（恰好三个功能及各自完成标准）。
 * baseVersionId 必须等于创意当前最新版本 id（无版本时为 null），否则 409 STALE_SCOPE_VERSION。
 * 新版本使之前待审或已批准的版本失效（superseded），创意回到 pending_review。
 */
export const ProposeScopeSchema = z.object({
  baseVersionId: z.uuid().nullable(),
  features: z.array(ScopeFeatureSchema).length(3),
  pageScope: text(2000),
  style: nullableText(500).optional(),
  notes: nullableText(2000).optional(),
});
export type ProposeScopeRequest = z.infer<typeof ProposeScopeSchema>;

/**
 * POST /api/ideas/:id/reviews — 人工审核。
 * scopeVersionId 必须等于创意当前最新版本 id（无版本时为 null，仅 reject 可用），否则 409 STALE_SCOPE_VERSION。
 * - approve：仅当最新版本 pending_review
 * - return：仅当最新版本 pending_review，需 reason
 * - reject：open/pending_review/returned/approved 均可，需 reason
 */
export const ReviewSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), scopeVersionId: z.uuid(), reason: nullableText(2000).optional() }),
  z.object({ decision: z.literal('return'), scopeVersionId: z.uuid(), reason: text(2000) }),
  z.object({ decision: z.literal('reject'), scopeVersionId: z.uuid().nullable(), reason: text(2000) }),
]);
export type ReviewRequest = z.infer<typeof ReviewSchema>;

/** 列表分页：按时间倒序，cursor 为上一页返回的 nextCursor。 */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

/** GET /api/submissions */
export const ListSubmissionsQuerySchema = PageQuerySchema.extend({
  source: z.enum(SUBMISSION_SOURCES).optional(),
  ideaId: z.uuid().optional(),
});
export type ListSubmissionsQuery = z.input<typeof ListSubmissionsQuerySchema>;

/** GET /api/ideas — status 可重复：?status=open&status=returned */
export const ListIdeasQuerySchema = PageQuerySchema.extend({
  status: z
    .union([z.enum(IDEA_STATUSES), z.array(z.enum(IDEA_STATUSES))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
});
export type ListIdeasQuery = z.input<typeof ListIdeasQuerySchema>;

// ---------------------------------------------------------------------------
// 响应类型
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SubmissionDto {
  id: string;
  source: SubmissionSource;
  /** source 为 manual/sample 时为 true，前端须标记“非真实抖音接入”。 */
  isSimulated: boolean;
  sourceMessageId: string | null;
  authorName: string | null;
  /** 原文，不可修改。 */
  rawText: string;
  receivedAt: string;
  parseStatus: ParseStatus;
  fields: SubmissionFields;
  /** 当前整理字段中仍缺失的必填项。 */
  missingFields: TemplateField[];
  ideaId: string;
  relation: SubmissionRelation;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/submissions 的响应；deduplicated=true 时为已存在的投稿（HTTP 200），否则 201。 */
export interface CreateSubmissionResponse {
  submission: SubmissionDto;
  deduplicated: boolean;
}

export interface AttributionDto {
  id: string;
  submissionId: string;
  fromIdeaId: string;
  toIdeaId: string;
  fromRelation: SubmissionRelation;
  toRelation: SubmissionRelation;
  reason: string;
  actor: string;
  /** 由创意合并引起时为对应合并记录 id。 */
  mergeId: string | null;
  createdAt: string;
}

export interface SubmissionDetailDto extends SubmissionDto {
  attributions: AttributionDto[];
}

export interface ScopeVersionDto {
  id: string;
  ideaId: string;
  versionNo: number;
  /** 本次最终实现的恰好三个功能及各自完成标准（区别于观众优先项）。 */
  features: [ScopeFeature, ScopeFeature, ScopeFeature];
  pageScope: string;
  style: string | null;
  notes: string | null;
  status: ScopeVersionStatus;
  proposedBy: string;
  createdAt: string;
  statusChangedAt: string;
}

export interface ReviewDto {
  id: string;
  ideaId: string;
  scopeVersionId: string | null;
  decision: ReviewDecision;
  reason: string | null;
  reviewer: string;
  createdAt: string;
}

export interface IdeaMergeDto {
  id: string;
  sourceIdeaId: string;
  targetIdeaId: string;
  reason: string;
  actor: string;
  createdAt: string;
}

/** 汇总后的全部期望功能，每项保留来源投稿。 */
export interface DesiredFeatureDto {
  text: string;
  submissionId: string;
  relation: SubmissionRelation;
}

export interface IdeaSummaryDto {
  id: string;
  title: string;
  status: IdeaStatus;
  mergedIntoId: string | null;
  currentScopeVersionId: string | null;
  approvedScopeVersionId: string | null;
  submissionCount: number;
  feedbackCount: number;
  /** 包含 manual/sample 投稿时为 true。 */
  hasSimulatedSubmissions: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchReadinessDto {
  launchable: boolean;
  /** launchable=true 时为可用于立项的批准版本。 */
  approvedScope: ScopeVersionDto | null;
  /** launchable=false 的原因，便于前端展示。 */
  reason: string | null;
}

export interface IdeaDetailDto extends IdeaSummaryDto {
  /** origin + duplicate 投稿（创意来源）。 */
  submissions: SubmissionDto[];
  /** 补充反馈，单独列出，不改变本次范围。 */
  feedback: SubmissionDto[];
  /** 全部期望功能（来自 origin/duplicate 投稿），保留来源。 */
  desiredFeatures: DesiredFeatureDto[];
  scopeVersions: ScopeVersionDto[];
  reviews: ReviewDto[];
  /** 合并进本创意的记录，以及本创意被合并出去的记录。 */
  mergesIn: IdeaMergeDto[];
  mergeOut: IdeaMergeDto | null;
  launch: LaunchReadinessDto;
}

/** POST /api/ideas/:id/reviews 响应。 */
export interface ReviewResponse {
  review: ReviewDto;
  idea: IdeaDetailDto;
}

/** GET /api/me */
export interface MeDto {
  actor: string;
  roles: Role[];
}

// ---------------------------------------------------------------------------
// SSE：GET /api/events
// ---------------------------------------------------------------------------

/**
 * 服务端在事务提交后推送；事件只携带 id，前端据此重新获取详情。
 * 断线重连后应重新拉取列表，事件流不保证补发。
 */
export type WorkbenchEvent =
  | { type: 'submission.created'; submissionId: string; ideaId: string }
  | { type: 'submission.updated'; submissionId: string; ideaId: string }
  | { type: 'idea.updated'; ideaId: string };
