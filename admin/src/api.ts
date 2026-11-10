import type { PolicyState } from '../../shared/management';
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

export type Role = 'owner' | 'policy_admin' | 'viewer' | 'dept_viewer';
export const ROLE_RANK: Record<Role, number> = { dept_viewer: 0, viewer: 1, policy_admin: 2, owner: 3 };
export const atLeast = (me: Me, min: Role) => ROLE_RANK[me.role] >= ROLE_RANK[min];

export type Me = { email: string; organization: string; role: Role; department: string | null };
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
export type Coverage = {
  from: string;
  to: string;
  department: string | null;
  totals: { devices: number; current: number; stopped: number };
  departments: { department: string | null; assignedVersion: string | null; devices: number; current: number; states: Record<PolicyState, number> }[];
  extensionVersions: { version: string; count: number }[];
};
export type PolicyVersion = { id: number; version: string; createdAt: string; createdBy: string };
export type Assignment = { department: string | null; policyId: number; version: string; minExtensionVersion: string | null; publishedAt: string; publishedBy: string };
export type Token = { id: number; label: string; department: string | null; createdAt: string; revokedAt: string | null };
export type IssuedToken = { id: number; label: string; department: string | null; token: string; bootstrap: unknown; bootstrapGoogle: unknown };
export type AdminAccount = { id: number; email: string; role: Role; department: string | null; createdAt: string; disabledAt: string | null };
export type AuditEntry = { id: number; at: string; adminEmail: string; action: string; detail: Record<string, unknown> };

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  me: () => call<Me>('/admin/me'),
  login: (email: string, password: string) => call<{ email: string }>('/admin/session', json('POST', { email, password })),
  logout: () => call<void>('/admin/session', { method: 'DELETE' }),
  stats: (q: { from: string; to: string; department?: string }) =>
    call<Stats>(`/admin/stats?${new URLSearchParams({ from: q.from, to: q.to, ...(q.department ? { department: q.department } : {}) })}`),
  coverage: (department?: string) => call<Coverage>(`/admin/coverage${department ? `?${new URLSearchParams({ department })}` : ''}`),
  policies: () => call<PolicyVersion[]>('/admin/policies'),
  policy: (id: number) => call<{ id: number; version: string; createdAt: string; policy: Policy }>(`/admin/policies/${id}`),
  savePolicy: (policy: Policy) => call<{ id: number; version: string }>('/admin/policies', json('POST', { policy })),
  exportUrl: (id: number, format: 'google' | 'raw') => `/admin/policies/${id}/export?format=${format}`,
  assignments: () => call<Assignment[]>('/admin/assignments'),
  assign: (a: { department: string | null; policyId: number; minExtensionVersion: string | null }) => call<void>('/admin/assignments', json('PUT', a)),
  unassign: (department: string | null) => call<void>(`/admin/assignments${department ? `?${new URLSearchParams({ department })}` : ''}`, { method: 'DELETE' }),
  tokens: () => call<Token[]>('/admin/tokens'),
  createToken: (label: string, department: string | null) => call<IssuedToken>('/admin/tokens', json('POST', { label, department })),
  revokeToken: (id: number) => call<void>(`/admin/tokens/${id}`, { method: 'DELETE' }),
  admins: () => call<AdminAccount[]>('/admin/admins'),
  createAdmin: (a: { email: string; password: string; role: Role; department: string | null }) => call<{ id: number }>('/admin/admins', json('POST', a)),
  updateAdmin: (id: number, a: { role: Role; department: string | null }) => call<void>(`/admin/admins/${id}`, json('PATCH', a)),
  disableAdmin: (id: number) => call<void>(`/admin/admins/${id}`, { method: 'DELETE' }),
  audit: () => call<AuditEntry[]>('/admin/audit'),
};
