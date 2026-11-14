import { useEffect, useState } from 'react';
import type { UsageEvent } from '../../../shared/usage-event';
import { lastSentUsage } from '../../infra/reporting';
import { useStore } from '../store';

/** 利用記録を組織へ送っているときだけ、送る項目と「最後に送った記録」の中身をそのまま見せる（SERVER_DESIGN.md §3-1） */
export function UsageNotice({ open }: { open: boolean }) {
  const reporting = useStore((s) => s.result?.policy.status === 'active' && s.result.policy.reporting);
  const [last, setLast] = useState<UsageEvent | null>(null);
  useEffect(() => {
    if (open && reporting) void lastSentUsage().then(setLast);
  }, [open, reporting]);
  if (!reporting) return null;
  return (
    <section className="settings-usage" aria-labelledby="usage-title">
      <h3 id="usage-title" className="settings-group-title">組織へ送っている利用記録</h3>
      <p className="hint">出力したとき・止まったときに記録を送ります。文章・対応表は送りません。</p>
      <details className="more">
        <summary>送る項目と、最後に送った記録</summary>
        <ul>
          <li>送る項目: 時刻（1時間単位）、拡張とポリシーの版、部署、段階、用途、出力先、種類ごとの件数、手動で直した回数、注意度、止まった理由の種類</li>
          <li>送らない項目: 原文、加工後の文章、候補の文字列、元に戻すための対応表、文章の長さ、あなたのアカウント</li>
        </ul>
        {last ? (
          <pre className="usage-json" aria-label="最後に送った記録">{JSON.stringify(last, null, 2)}</pre>
        ) : (
          <p>まだ送った記録はありません。</p>
        )}
      </details>
    </section>
  );
}
