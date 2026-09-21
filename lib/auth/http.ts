import { publicOrigin } from './config';
import { getRequestUser } from './session';
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function verifyOrigin(req: Request): void {
  if (req.headers.get('origin') !== publicOrigin())
    throw new AuthError(403, '请求来源不受信任，请刷新后重试。');
}
export async function requireUser(req: Pick<Request, 'headers'>) {
  const user = await getRequestUser(req);
  if (!user) throw new AuthError(401, '请先登录。');
  return user;
}
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 8192) throw new AuthError(413, '请求过大。');
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AuthError(400, '请求格式不正确。');
  }
}
