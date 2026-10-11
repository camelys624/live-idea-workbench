import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { EventHub } from '../src/events.ts';
import { loadIntegrations } from '../src/integrations.ts';
import { migrate } from '../src/migrate.ts';

const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://workbench:workbench@127.0.0.1:55432/workbench';

export interface TestContext {
  app: FastifyInstance;
  pool: pg.Pool;
  events: EventHub;
}

/** 每个测试文件使用独立的临时数据库，跑完删除。 */
export function useTestApp(): TestContext {
  const ctx = {} as TestContext;
  const dbName = `wb_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(BASE_URL);
    url.pathname = `/${dbName}`;
    ctx.pool = createPool(url.toString());
    await migrate(ctx.pool);
    ctx.events = new EventHub();
    ctx.app = buildApp({
      config: loadConfig({ DATABASE_URL: url.toString(), AUTH_MODE: 'dev' }),
      pool: ctx.pool,
      events: ctx.events,
      integrations: loadIntegrations({}),
      logger: false,
    });
    await ctx.app.ready();
  });

  afterAll(async () => {
    await ctx.app?.close();
    await ctx.pool?.end();
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  return ctx;
}

export const TEMPLATE_SAMPLE =
  '投稿｜想做啥：自习室座位预约｜给谁用：大学生｜解决啥问题：图书馆占座难｜' +
  '希望它能干啥：查看空位、预约座位、签到、排行榜、暗黑模式｜最希望先做哪3件事：查看空位、预约座位、签到｜' +
  '想要几个页面、分别放啥：首页看空位，预约页，个人页｜做到啥样算完成：能演示预约到签到全流程｜喜欢啥风格（选填）：清新';

export const THREE_FEATURES = [
  { title: '查看空位', acceptanceCriteria: '首页展示各区空位数' },
  { title: '预约座位', acceptanceCriteria: '选座后生成预约记录' },
  { title: '签到', acceptanceCriteria: '预约时段内可签到' },
];
