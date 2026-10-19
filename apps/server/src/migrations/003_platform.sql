-- 平台写入先持久化；一个创意只建立一个独立小产品，范围变更不重复立项。
create table products (
  id uuid primary key,
  idea_id uuid not null unique references ideas(id),
  scope_version_id uuid not null references scope_versions(id),
  project_id uuid,
  repo_path text not null unique,
  task jsonb,
  launched_by text not null,
  created_at timestamptz not null default now()
);
create table review_tasks (
  idea_id uuid primary key references ideas(id),
  task jsonb not null
);
create table platform_operations (
  id uuid primary key,
  idea_id uuid not null references ideas(id),
  product_id uuid references products(id),
  kind text not null check (kind in ('create_review_task','create_product_project','create_dev_task','assign_agent','launch')),
  state text not null check (state in ('pending','running','succeeded','failed','unknown')),
  actor text not null,
  attempt integer not null default 1 check (attempt > 0),
  remote_id uuid,
  error text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index platform_operations_idea_idx on platform_operations(idea_id, created_at);
create unique index platform_operations_creation_idx on platform_operations(idea_id,kind)
  where kind in ('create_review_task','create_product_project','create_dev_task');
