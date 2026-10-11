import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ROLES, type Role } from '@workbench/contracts';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';

export interface Identity {
  actor: string;
  roles: Role[];
}

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity;
  }
}

const DEV_IDENTITY: Identity = { actor: 'dev', roles: [...ROLES] };

/**
 * 身份解析。工作台部署在可信身份代理/私网之后：
 * - trusted-proxy：代理注入 x-workbench-user、x-workbench-roles（逗号分隔），并携带共享密钥
 *   x-workbench-proxy-secret，防止绕过代理直连伪造身份。
 * - dev：本机开发；可用相同请求头模拟其他身份，缺省为 dev（全部角色）。
 */
export function resolveIdentity(config: Config, request: FastifyRequest): Identity {
  const user = headerValue(request, 'x-workbench-user');
  const rolesHeader = headerValue(request, 'x-workbench-roles');

  if (config.AUTH_MODE === 'trusted-proxy') {
    const secret = headerValue(request, 'x-workbench-proxy-secret') ?? '';
    const expected = Buffer.from(config.PROXY_SHARED_SECRET!);
    const given = Buffer.from(secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AppError('UNAUTHENTICATED', '请求未经过可信代理');
    }
    if (!user) throw new AppError('UNAUTHENTICATED', '缺少用户身份');
  } else if (!user) {
    return DEV_IDENTITY;
  }

  const roles = (rolesHeader ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  return { actor: user!, roles: [...new Set(roles)] };
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

export function requireRole(role: Role) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.identity.roles.includes(role)) {
      throw new AppError('FORBIDDEN', `需要 ${role} 权限`);
    }
  };
}
