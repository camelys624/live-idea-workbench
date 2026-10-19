-- AI advice is durable history, never a scope version, review or execution grant.
create table ai_assessments (
  id uuid primary key,
  idea_id uuid not null references ideas (id),
  data jsonb not null,
  check (jsonb_typeof(data) = 'object'),
  check (data ?& array[
    'id', 'ideaId', 'status', 'decision', 'reason', 'suggestedTargetIdeaId',
    'suggestedFeatures', 'model', 'error', 'requestedBy', 'createdAt', 'completedAt'
  ]),
  check (coalesce(data ->> 'id' = id::text and data ->> 'ideaId' = idea_id::text, false)),
  check (coalesce(data ->> 'status' in ('pending', 'succeeded', 'failed'), false)),
  check (jsonb_typeof(data -> 'requestedBy') = 'string'),
  check (jsonb_typeof(data -> 'createdAt') = 'string'),
  check (jsonb_typeof(data -> 'model') in ('string', 'null')),
  check (case when jsonb_typeof(data -> 'suggestedFeatures') = 'array'
    then jsonb_array_length(data -> 'suggestedFeatures') = 0
      or workbench_valid_scope_features(data -> 'suggestedFeatures')
    else false end),
  check (case data ->> 'status'
    when 'pending' then
      data -> 'decision' = 'null'::jsonb and data -> 'reason' = 'null'::jsonb
      and data -> 'suggestedTargetIdeaId' = 'null'::jsonb
      and data -> 'suggestedFeatures' = '[]'::jsonb
      and data -> 'error' = 'null'::jsonb and data -> 'completedAt' = 'null'::jsonb
    when 'succeeded' then
      coalesce(data ->> 'decision' in ('create_task', 'duplicate', 'feedback', 'needs_info', 'skip'), false)
      and jsonb_typeof(data -> 'reason') = 'string' and btrim(data ->> 'reason') <> ''
      and data -> 'error' = 'null'::jsonb and jsonb_typeof(data -> 'completedAt') = 'string'
      and case when data ->> 'decision' in ('duplicate', 'feedback')
        then jsonb_typeof(data -> 'suggestedTargetIdeaId') = 'string'
          and data ->> 'suggestedTargetIdeaId' <> idea_id::text
        else data -> 'suggestedTargetIdeaId' = 'null'::jsonb end
    when 'failed' then
      data -> 'decision' = 'null'::jsonb and data -> 'reason' = 'null'::jsonb
      and data -> 'suggestedTargetIdeaId' = 'null'::jsonb
      and data -> 'suggestedFeatures' = '[]'::jsonb
      and jsonb_typeof(data -> 'error') = 'string' and btrim(data ->> 'error') <> ''
      and jsonb_typeof(data -> 'completedAt') = 'string'
    else false end)
);

-- A committed pending record arbitrates requests from every service instance.
create unique index ai_assessments_one_pending_idx on ai_assessments (idea_id)
  where data ->> 'status' = 'pending';
create index ai_assessments_history_idx on ai_assessments (idea_id, (data ->> 'createdAt') desc, id desc);
create trigger ai_assessments_no_delete before delete on ai_assessments
  for each row execute function workbench_forbid_delete();
