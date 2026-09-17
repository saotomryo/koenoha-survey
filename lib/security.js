import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { AppError, check } from './domain.js';

function key() {
  check(process.env.SESSION_SECRET?.length >= 32 && process.env.ADMIN_PASSWORD?.length >= 12, '管理者パスワードとセッション署名用の環境変数を設定してください。', 503);
  return createHmac('sha256', process.env.SESSION_SECRET).update(process.env.ADMIN_PASSWORD).digest();
}
export function passwordMatches(password) {
  key();
  const hash = value => createHash('sha256').update(String(value || '')).digest();
  return timingSafeEqual(hash(password), hash(process.env.ADMIN_PASSWORD));
}
export function signToken(payload, purpose, ttl = 8 * 3600_000) {
  const body = Buffer.from(JSON.stringify({ ...payload, purpose, exp: Date.now() + ttl })).toString('base64url');
  return `${body}.${createHmac('sha256', key()).update(body).digest('base64url')}`;
}
export function verifyToken(token, purpose) {
  check(typeof token === 'string' && token.length <= 400_000, 'セッションが無効です。', 401);
  const [body, signature, extra] = token.split('.');
  check(body && signature && !extra, 'セッションが無効です。', 401);
  const expected = createHmac('sha256', key()).update(body).digest('base64url');
  check(signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected)), 'セッションが無効です。', 401);
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw new AppError(401, 'セッションが無効です。'); }
  check(data.purpose === purpose && Number.isFinite(data.exp) && data.exp > Date.now(), 'セッションの有効期限が切れました。', 401);
  return data;
}
export function isAdmin(req) {
  const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('survey_admin='));
  if (!cookie) return false;
  try { return verifyToken(cookie.slice('survey_admin='.length), 'admin').admin === true; } catch { return false; }
}
export function adminCookie(token, clear = false) {
  return `survey_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 8 * 3600}${process.env.VERCEL || process.env.APP_ORIGIN?.startsWith('https:') ? '; Secure' : ''}`;
}
export function requireSameOrigin(req) {
  check(req.headers['x-survey-request'] === '1', '不正なリクエストです。', 403);
  const origin = req.headers.origin;
  if (origin) {
    const expected = process.env.APP_ORIGIN || `${process.env.VERCEL ? 'https' : 'http'}://${req.headers.host}`;
    check(origin === expected, 'このアクセス元は許可されていません。', 403);
  }
}
