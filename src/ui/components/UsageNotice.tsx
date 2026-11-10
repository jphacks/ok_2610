import { useEffect, useState } from 'react';
import type { DeviceStatus } from '../../../shared/management';
import type { UsageEvent } from '../../../shared/usage-event';
import { lastSentStatus } from '../../infra/management';
import { lastSentUsage } from '../../infra/reporting';
import { useStore } from '../store';

/**
 * 組織へ送っているものを、送る項目と「最後に送った中身」そのままで見せる（SERVER_DESIGN.md §3-1・§12-4）。
 * 利用記録は組織が有効にしたときだけ、適用状況は組織の管理下にあるときだけ送る。
 */
export function UsageNotice({ open }: { open: boolean }) {
  const policy = useStore((s) => s.result?.policy);
  const reporting = policy?.status === 'active' && policy.reporting;
  const managed = policy !== undefined && policy.status !== 'none';
  const [last, setLast] = useState<UsageEvent | null>(null);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  useEffect(() => {
    if (open && reporting) void lastSentUsage().then(setLast);
    if (open && managed) void lastSentStatus().then(setStatus);
  }, [open, reporting, managed]);
  const serverManaged = policy !== undefined && policy.status !== 'none' && policy.source === 'server';
  if (!reporting && !status && !serverManaged) return null;
  return (
    <>
      {reporting && (
        <details className="data-notes" open>
          <summary>組織へ送っている利用記録</summary>
          <p>出力したときと、認証情報などで出力が止まったときに1件ずつ送ります。文章・加工した語・対応表は送りません。</p>
          <ul>
            <li>送る項目: 時刻（1時間単位）、拡張とポリシーの版、部署、段階、用途、出力先、種類ごとの件数、手動で直した回数、注意度、止まった理由の種類</li>
            <li>送らない項目: 原文、加工後の文章、候補の文字列、元に戻すための対応表、文章の長さ、あなたのアカウント</li>
          </ul>
          {last ? (
            <>
              <p>最後に送った記録:</p>
              <pre className="usage-json" aria-label="最後に送った記録">{JSON.stringify(last, null, 2)}</pre>
            </>
          ) : (
            <p>まだ送った記録はありません。</p>
          )}
        </details>
      )}
      <details className="data-notes" open>
        <summary>組織へ送っている適用状況</summary>
        <p>組織ポリシーがこの端末に届いているかを管理者が確かめるため、1日1回まで送ります。</p>
        <ul>
          <li>送る項目: 日付、この拡張の中で作った乱数の番号、拡張とポリシーの版、ポリシーの状態と配布元、部署</li>
          <li>送らない項目: 文章、あなたのアカウント、端末の名前</li>
        </ul>
        {status ? (
          <>
            <p>最後に送った適用状況:</p>
            <pre className="usage-json" aria-label="最後に送った適用状況">{JSON.stringify(status, null, 2)}</pre>
          </>
        ) : (
          <p>まだ送った適用状況はありません。</p>
        )}
      </details>
    </>
  );
}
