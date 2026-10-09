import { z } from 'zod';

const ConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    AUTH_MODE: z.enum(['trusted-proxy', 'dev']).default('trusted-proxy'),
    PROXY_SHARED_SECRET: z.string().optional(),
  })
  .refine((c) => c.AUTH_MODE !== 'trusted-proxy' || (c.PROXY_SHARED_SECRET ?? '').length >= 16, {
    message: 'AUTH_MODE=trusted-proxy 时 PROXY_SHARED_SECRET 必须配置且不少于 16 个字符',
    path: ['PROXY_SHARED_SECRET'],
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    ...env,
    PROXY_SHARED_SECRET: env.PROXY_SHARED_SECRET || undefined,
  });
  if (!parsed.success) {
    throw new Error(`配置无效：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
