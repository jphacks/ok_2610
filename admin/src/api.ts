import type { Policy } from '../../src/core/policy';

// 管理 API（server/src/app.ts）の呼び出し。同じオリジンの /admin/* だけを使い、セッションは Cookie で送る。

export class ApiError extends Error {
  constructor(readonly status: number, readonly issues: { path: string; message: string }[] = []) {
    super(`HTTP ${status}`);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
  });
  if (!res.ok) {
    const body = res.headers.get('content-type')?.includes('json') ? ((await res.json()) as { issues?: { path: string; message: string }[] }) : {};
    throw new ApiError(res.status, body.issues);
  }
  return (res.status === 204 || res.status === 202 ? undefined : await res.json()) as T;
}

export type Me = { email: string; organization: string };
export type Stats = {
  from: string;
  to: string;
  department: string | null;
  suppressed: boolean;
  totals: { outputs: number; blocked: number };
  byDestination: { destination: string; count: number }[];
  masked: { category: string; count: number }[];
  kept: { category: string; count: number }[];
  riskLevels: { level: string; count: number }[];
  blockers: { kind: string; count: number }[];
  daily: { date: string; outputs: number; blocked: number }[];
  departments: { department: string; count: number | null }[];
};
export type PolicyVersion = { id: number; version: string; createdAt: string; createdBy: string };
export type Token = { id: number; label: string; createdAt: string; revokedAt: string | null };

export const api = {
  me: () => call<Me>('/admin/me'),
  login: (email: string, password: string) => call<{ email: string }>('/admin/session', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => call<void>('/admin/session', { method: 'DELETE' }),
  stats: (q: { from: string; to: string; department?: string }) =>
    call<Stats>(`/admin/stats?${new URLSearchParams({ from: q.from, to: q.to, ...(q.department ? { department: q.department } : {}) })}`),
  policies: () => call<PolicyVersion[]>('/admin/policies'),
  policy: (id: number) => call<{ id: number; version: string; createdAt: string; policy: Policy }>(`/admin/policies/${id}`),
  savePolicy: (policy: Policy) => call<{ id: number; version: string }>('/admin/policies', { method: 'POST', body: JSON.stringify({ policy }) }),
  exportUrl: (id: number, format: 'google' | 'raw') => `/admin/policies/${id}/export?format=${format}`,
  tokens: () => call<Token[]>('/admin/tokens'),
  createToken: (label: string) => call<{ id: number; label: string; token: string }>('/admin/tokens', { method: 'POST', body: JSON.stringify({ label }) }),
  revokeToken: (id: number) => call<void>(`/admin/tokens/${id}`, { method: 'DELETE' }),
};
