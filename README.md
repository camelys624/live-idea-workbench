# live-idea-workbench｜直播创意工作台

你出创意，我出 token。收集直播观众的小产品创意，经人工合并、审核本次三个功能后再立项派单。

> **接入状态：** 尚未接通真实抖音评论。当前只能通过人工录入（`manual`）或示例数据（`sample`）验证工作台流程，这类投稿在接口中带 `isSimulated: true`，前端必须明确标记。

## 技术栈

- 前端：React + TypeScript + Vite（CSR）、shadcn/ui 源码与 Tailwind CSS，`apps/web`；使用真实后端 API，无浏览器侧 CLI 或执行凭据
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
npm run dev:web                       # 另一个终端：http://127.0.0.1:5173
npm test                              # 需要本地 Postgres；每个测试文件使用临时数据库
npm run typecheck
npm run build                        # 生成 apps/web/dist
```

`docker-compose.yml` 中的账号口令仅供本机开发。

## 目录

```
packages/contracts/   API 契约（前后端唯一来源）
apps/server/          后端
  src/migrations/     SQL 迁移，按文件名顺序执行
  src/modules/        submissions（投稿、模板解析、归属）、ideas（创意、合并、范围版本、审核）
  test/               集成测试（真实 Postgres）
apps/web/             投稿、范围审核、合并反馈界面（React CSR）
  src/                页面、共享契约表单、同源 API 客户端及回归测试
  components.json     shadcn/ui 风格与源码路径配置
  src/components/ui/  实际引用的 shadcn/Radix 组件源码
docs/                 业务规则与接手说明
```

后端业务规则、API 与后续接手边界见 [`docs/backend.md`](docs/backend.md)。
前端交互、运行方式、实际验证与未就绪能力见 [`docs/frontend.md`](docs/frontend.md)。AI 判断及 Multica 立项/分配/执行的共用契约与部署配置见 `docs/backend.md` 的 ROBB-11 一节。前端已实现配置摘要、AI 判断理由、人工立项/分配/独立启动和执行/对账交互；当前后端仅实现配置状态 `GET /api/integrations`，其余路由返回 404 时相关操作明确禁用。人工批准不表示已创建平台任务，前端契约演练不代表真实模型或平台联调通过。
