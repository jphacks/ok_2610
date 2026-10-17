// 標準ログに本文・原文の一部・対応表・秘密値を出さない（LP-04）。
// 受け付けるのは数値と、決められた種類の文字列だけ。本文の文字列は型で渡せない。

type LogFields = Record<string, number | boolean>;
type LogEvent = 'analyze' | 'engine' | 'output' | 'restore' | 'error';

export function log(event: LogEvent, fields: LogFields = {}): void {
  if (import.meta.env.MODE !== 'development') return;
  console.info(`[text-cleaner] ${event}`, fields);
}
