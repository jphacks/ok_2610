import { readFileSync } from 'node:fs';
import { analyze, type AnalyzeInput } from '../../src/core/analyze';
import type { Settings } from '../../src/core/model/types';

export const demoEmail = readFileSync(new URL('../fixtures/demo-email.txt', import.meta.url), 'utf8');

export function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    stage: 'B',
    purpose: 'summary',
    keep: { relationships: true, dates: true, amounts: true, organizations: false },
    profile: ['rule'],
    customTerms: [],
    includeHistory: false,
    ...overrides,
  };
}

export function run(text: string, overrides: Partial<AnalyzeInput> = {}) {
  return analyze({
    text,
    settings: settings(),
    ops: [],
    engineOutputs: [],
    policy: { status: 'none' },
    conditions: { status: 'unanswered', restricted: [], consult: [] },
    ...overrides,
  });
}
