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
  RequestAssessmentSchema,
  CreateProductSchema,
  AssignAgentSchema,
  LaunchSchema,
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
import { AiService } from './modules/ai/service.ts';
import { PlatformService } from './modules/platform/service.ts';
import type { Gateway } from './modules/platform/gateway.ts';

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
  /** 仅测试边界替身；部署入口始终使用受控 CLI。 */
  gateway?: Gateway;
  logger?: boolean;
}

export function buildApp({
  config,
  pool,
  events = new EventHub(),
  integrations = loadIntegrations(),
  gateway,
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
  const dispatcher = { preHandler: requireRole('dispatcher') };
  const launcher = { preHandler: requireRole('launcher') };
  const platform = new PlatformService(pool, events, integrations, gateway);
  const ai = new AiService(pool, events, integrations, (ideaId, assessmentId) => platform.createReviewTask(ideaId, assessmentId));
  app.addHook('onReady', async () => {
    await platform.recover();
    await ai.recover();
  });

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

  // 平台写入在本请求内完成，响应/SSE 只报告持久记录；无隐式后台重试。
  app.get('/api/ideas/:id/platform', async request => platform.get(parse(IdParams, request.params).id));
  app.post('/api/ideas/:id/assessments', operator, async request => {
    parse(RequestAssessmentSchema, request.body);
    return ai.assess(parse(IdParams, request.params).id, request.identity.actor);
  });
  app.post('/api/ideas/:id/product', dispatcher, async (request, reply) => {
    const body = parse(CreateProductSchema, request.body);
    const ideaId = parse(IdParams, request.params).id;
    const existing = (await platform.get(ideaId)).product;
    const result = await platform.createProduct(ideaId, body.scopeVersionId, request.identity.actor);
    return reply.status(existing ? 200 : 202).send(result);
  });
  app.get('/api/agents', dispatcher, async () => platform.agents());
  app.post('/api/products/:id/assignment', dispatcher, async request => {
    const body = parse(AssignAgentSchema, request.body);
    return platform.assign(parse(IdParams, request.params).id, body.agentId, request.identity.actor);
  });
  app.get('/api/products/:id/launch-readiness', launcher, async request => platform.readiness(parse(IdParams, request.params).id));
  app.post('/api/products/:id/launch', launcher, async request => {
    const body = parse(LaunchSchema, request.body);
    return platform.launch(parse(IdParams, request.params).id, body.agentId, request.identity.actor);
  });
  app.get('/api/products/:id/execution', async request => platform.execution(parse(IdParams, request.params).id));
  app.post('/api/platform-operations/:id/reconcile', dispatcher, async request => platform.reconcile(parse(IdParams, request.params).id));

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
