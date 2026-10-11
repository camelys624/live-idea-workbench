import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  CreateSubmissionSchema,
  ListIdeasQuerySchema,
  ListSubmissionsQuerySchema,
  MergeIdeaSchema,
  ProposeScopeSchema,
  ReattributeSubmissionSchema,
  ReviewSchema,
  UpdateSubmissionFieldsSchema,
  type ApiErrorBody,
  type IntegrationStatusDto,
  type MeDto,
  type WorkbenchEvent,
} from '@workbench/contracts';
import { requireRole, resolveIdentity } from './auth.ts';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { EventHub } from './events.ts';
import { loadIntegrations, type Integrations } from './integrations.ts';
import { IdeaService } from './modules/ideas/service.ts';
import { SubmissionService } from './modules/submissions/service.ts';

const IdParams = z.object({ id: z.uuid() });
const SSE_HEARTBEAT_MS = 25_000;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', '请求参数无效', z.flattenError(result.error));
  }
  return result.data;
}

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  events?: EventHub;
  /** 缺省按 process.env 读取；测试可注入。 */
  integrations?: Integrations;
  logger?: boolean;
}

export function buildApp({
  config,
  pool,
  events = new EventHub(),
  integrations = loadIntegrations(),
  logger = true,
}: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: logger && {
      // 投稿原文可能含个人信息，不记录请求体；身份/代理头不入日志。
      redact: ['req.headers["x-workbench-proxy-secret"]', 'req.headers.cookie', 'req.headers.authorization'],
    },
    bodyLimit: 64 * 1024,
  });
  const submissions = new SubmissionService(pool, events);
  const ideas = new IdeaService(pool, events);
  const operator = { preHandler: requireRole('operator') };
  const reviewer = { preHandler: requireRole('reviewer') };

  app.decorateRequest('identity');
  app.addHook('onRequest', async (request) => {
    if (request.url === '/healthz') return;
    request.identity = resolveIdentity(config, request);
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof AppError) {
      const body: ApiErrorBody = { error: { code: err.code, message: err.message, details: err.details } };
      return reply.status(err.status).send(body);
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      const body: ApiErrorBody = { error: { code: 'VALIDATION_FAILED', message: e.message ?? '请求无效' } };
      return reply.status(e.statusCode).send(body);
    }
    request.log.error(err);
    const body: ApiErrorBody = { error: { code: 'INTERNAL', message: '服务器内部错误' } };
    return reply.status(500).send(body);
  });

  app.get('/healthz', async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  app.get('/api/me', async (request): Promise<MeDto> => request.identity);

  // ----- 集成配置（ROBB-11）：只报告状态与缺项，不返回密钥 -----
  app.get('/api/integrations', async (): Promise<IntegrationStatusDto> => integrations.status);

  // ----- 投稿 -----
  app.post('/api/submissions', operator, async (request, reply) => {
    const body = parse(CreateSubmissionSchema, request.body);
    const result = await submissions.ingest(body, request.identity.actor);
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });
  app.get('/api/submissions', async (request) =>
    submissions.list(parse(ListSubmissionsQuerySchema, request.query)),
  );
  app.get('/api/submissions/:id', async (request) => submissions.get(parse(IdParams, request.params).id));
  app.patch('/api/submissions/:id/fields', operator, async (request) =>
    submissions.updateFields(
      parse(IdParams, request.params).id,
      parse(UpdateSubmissionFieldsSchema, request.body),
      request.identity.actor,
    ),
  );
  app.post('/api/submissions/:id/reattribute', operator, async (request) =>
    submissions.reattribute(
      parse(IdParams, request.params).id,
      parse(ReattributeSubmissionSchema, request.body),
      request.identity.actor,
    ),
  );

  // ----- 创意、合并、范围、审核 -----
  app.get('/api/ideas', async (request) => ideas.list(parse(ListIdeasQuerySchema, request.query)));
  app.get('/api/ideas/:id', async (request) => ideas.get(parse(IdParams, request.params).id));
  app.post('/api/ideas/:id/merge', operator, async (request) =>
    ideas.merge(parse(IdParams, request.params).id, parse(MergeIdeaSchema, request.body), request.identity.actor),
  );
  app.post('/api/ideas/:id/scope-versions', operator, async (request, reply) => {
    const version = await ideas.proposeScope(
      parse(IdParams, request.params).id,
      parse(ProposeScopeSchema, request.body),
      request.identity.actor,
    );
    return reply.status(201).send(version);
  });
  app.post('/api/ideas/:id/reviews', reviewer, async (request, reply) => {
    const result = await ideas.review(
      parse(IdParams, request.params).id,
      parse(ReviewSchema, request.body),
      request.identity.actor,
    );
    return reply.status(201).send(result);
  });

  // ----- SSE -----
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (event: WorkbenchEvent) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = events.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
