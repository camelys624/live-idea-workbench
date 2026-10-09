# live-idea-workbench｜直播创意工作台

你出创意，我出 token。收集直播观众的小产品创意，经人工合并、审核本次三个功能后再立项派单。

> **接入状态：** 尚未接通真实抖音评论。当前只能通过人工录入（`manual`）或示例数据（`sample`）验证工作台流程，这类投稿在接口中带 `isSimulated: true`，前端必须明确标记。

## 技术栈

- 前端：React + TypeScript + Vite（CSR），`apps/web`，由前端负责初始化
- 后端：Node.js 22 + TypeScript + Fastify 模块化单体，`apps/server`
- 数据库：PostgreSQL 16
- 前后端共享契约：`packages/contracts`（zod 请求 schema + 响应类型 + 枚举）

npm workspaces 单仓。后端直接用 Node 原生 TypeScript 类型擦除运行，不需要构建步骤；只用可擦除语法（不用 `enum`、参数属性、`namespace`）。

## 本地开发

```bash
npm install
npm run db:up                         # docker compose 启动本地 Postgres（端口 55432）
cp apps/server/.env.example apps/server/.env
npm run db:migrate
npm run dev:server                    # http://127.0.0.1:3000
npm test                              # 需要本地 Postgres；每个测试文件使用临时数据库
npm run typecheck
```

`docker-compose.yml` 中的账号口令仅供本机开发。

## 目录

```
packages/contracts/   API 契约（前后端唯一来源）
apps/server/          后端
  src/migrations/     SQL 迁移，按文件名顺序执行
  src/modules/        submissions（投稿、模板解析、归属）、ideas（创意、合并、范围版本、审核）
  test/               集成测试（真实 Postgres）
docs/                 业务规则与接手说明
```

后端业务规则、API 与后续接手边界见 [`docs/backend.md`](docs/backend.md)。
