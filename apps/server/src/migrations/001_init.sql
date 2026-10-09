-- 直播创意工作台：投稿、合并与人工审核的核心数据模型。
-- 不变量尽量由数据库强制，服务端校验只是第一道防线。

-- 范围功能：恰好 3 项，每项 title 与 acceptanceCriteria 均为非空字符串。
create function workbench_valid_scope_features(features jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(features) = 'array'
     and jsonb_array_length(features) = 3
     and not exists (
       select 1 from jsonb_array_elements(features) f
       where jsonb_typeof(f -> 'title') is distinct from 'string'
          or btrim(f ->> 'title') = ''
          or jsonb_typeof(f -> 'acceptanceCriteria') is distinct from 'string'
          or btrim(f ->> 'acceptanceCriteria') = ''
     )
$$;

create table ideas (
  id uuid primary key,
  seq bigint generated always as identity unique,
  title text not null,
  status text not null default 'open'
    check (status in ('open', 'pending_review', 'returned', 'approved', 'rejected', 'merged')),
  merged_into_id uuid references ideas (id),
  current_scope_version_id uuid,
  approved_scope_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (merged_into_id is distinct from id),
  check ((status = 'merged') = (merged_into_id is not null)),
  -- 只有 approved 状态持有批准版本，且必须是最新版本：修改范围后旧批准不可沿用。
  check (
    (status = 'approved' and approved_scope_version_id is not null
       and approved_scope_version_id = current_scope_version_id)
    or (status <> 'approved' and approved_scope_version_id is null)
  )
);

create table submissions (
  id uuid primary key,
  seq bigint generated always as identity unique,
  source text not null check (source in ('manual', 'sample', 'douyin')),
  source_message_id text,
  author_name text,
  raw_text text not null,
  received_at timestamptz not null,
  parse_status text not null check (parse_status in ('complete', 'partial', 'unparsed')),
  -- 原文按模板解析的结果，不可修改；fields 为人工整理后的当前值。
  parsed_fields jsonb not null,
  fields jsonb not null,
  idea_id uuid not null references ideas (id),
  relation text not null check (relation in ('origin', 'duplicate', 'feedback')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 消息级去重：同一来源的同一消息只保存一次。
  unique (source, source_message_id)
);
create index submissions_idea_idx on submissions (idea_id);

-- 原文与来源不可修改。
create function workbench_submission_immutable() returns trigger
language plpgsql as $$
begin
  if new.raw_text is distinct from old.raw_text
     or new.source is distinct from old.source
     or new.source_message_id is distinct from old.source_message_id
     or new.author_name is distinct from old.author_name
     or new.received_at is distinct from old.received_at
     or new.parsed_fields is distinct from old.parsed_fields
     or new.parse_status is distinct from old.parse_status
     or new.created_by is distinct from old.created_by then
    raise exception 'submission original content is immutable' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger submissions_immutable before update on submissions
  for each row execute function workbench_submission_immutable();

-- 原文不可删除（合并/归属只改 idea_id）。
create function workbench_forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception '% rows cannot be deleted', tg_table_name using errcode = 'check_violation';
end $$;
create trigger submissions_no_delete before delete on submissions
  for each row execute function workbench_forbid_delete();

create table submission_field_edits (
  id uuid primary key,
  submission_id uuid not null references submissions (id),
  before_fields jsonb not null,
  after_fields jsonb not null,
  actor text not null,
  created_at timestamptz not null default now()
);
create index submission_field_edits_submission_idx on submission_field_edits (submission_id);

create table idea_merges (
  id uuid primary key,
  source_idea_id uuid not null references ideas (id),
  target_idea_id uuid not null references ideas (id),
  reason text not null,
  actor text not null,
  created_at timestamptz not null default now(),
  check (source_idea_id <> target_idea_id),
  unique (source_idea_id)
);
create index idea_merges_target_idx on idea_merges (target_idea_id);

-- 投稿归属变更历史：重复合并与补充反馈都可追溯。
create table submission_attributions (
  id uuid primary key,
  submission_id uuid not null references submissions (id),
  from_idea_id uuid not null references ideas (id),
  to_idea_id uuid not null references ideas (id),
  from_relation text not null,
  to_relation text not null check (to_relation in ('duplicate', 'feedback')),
  reason text not null,
  actor text not null,
  merge_id uuid references idea_merges (id),
  created_at timestamptz not null default now(),
  check (from_idea_id <> to_idea_id)
);
create index submission_attributions_submission_idx on submission_attributions (submission_id);

create table scope_versions (
  id uuid primary key,
  idea_id uuid not null references ideas (id),
  version_no integer not null check (version_no > 0),
  features jsonb not null check (workbench_valid_scope_features(features)),
  page_scope text not null check (btrim(page_scope) <> ''),
  style text,
  notes text,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'returned', 'rejected', 'superseded')),
  proposed_by text not null,
  created_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  unique (idea_id, version_no),
  unique (idea_id, id)
);

-- 范围版本内容不可修改：修改范围必须新建版本，旧批准随之失效。
create function workbench_scope_version_immutable() returns trigger
language plpgsql as $$
begin
  if new.features is distinct from old.features
     or new.page_scope is distinct from old.page_scope
     or new.style is distinct from old.style
     or new.notes is distinct from old.notes
     or new.idea_id is distinct from old.idea_id
     or new.version_no is distinct from old.version_no
     or new.proposed_by is distinct from old.proposed_by then
    raise exception 'scope version content is immutable' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger scope_versions_immutable before update on scope_versions
  for each row execute function workbench_scope_version_immutable();

-- 版本必须属于同一创意。
alter table ideas
  add constraint ideas_current_scope_fk foreign key (id, current_scope_version_id)
    references scope_versions (idea_id, id) deferrable initially deferred,
  add constraint ideas_approved_scope_fk foreign key (id, approved_scope_version_id)
    references scope_versions (idea_id, id) deferrable initially deferred;

create table reviews (
  id uuid primary key,
  idea_id uuid not null references ideas (id),
  scope_version_id uuid references scope_versions (id),
  decision text not null check (decision in ('approve', 'return', 'reject')),
  reason text,
  reviewer text not null,
  created_at timestamptz not null default now(),
  check (decision = 'approve' or (reason is not null and btrim(reason) <> '')),
  check (decision = 'reject' or scope_version_id is not null)
);
create index reviews_idea_idx on reviews (idea_id);

create trigger idea_merges_no_delete before delete on idea_merges
  for each row execute function workbench_forbid_delete();
create trigger submission_attributions_no_delete before delete on submission_attributions
  for each row execute function workbench_forbid_delete();
create trigger reviews_no_delete before delete on reviews
  for each row execute function workbench_forbid_delete();
create trigger scope_versions_no_delete before delete on scope_versions
  for each row execute function workbench_forbid_delete();
