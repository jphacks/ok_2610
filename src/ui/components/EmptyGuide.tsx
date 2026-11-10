import { useStore } from '../store';
import { SAMPLE_TEXT } from '../sample';

/** 文章がまだないときの案内。何をする道具かを3つの手順で示し、サンプルで試せるようにする */
export function EmptyGuide() {
  const setText = useStore((s) => s.setText);
  return (
    <section className="empty-guide" aria-labelledby="empty-guide-title">
      <h2 id="empty-guide-title">AI に貼る前に、個人情報を置き換えます</h2>
      <ol>
        <li>上の欄に文章を貼ります。Excel・CSV・PDF も読み込めます。</li>
        <li>色の付いた箇所が置き換えた語です。押すと理由と直し方が出ます。</li>
        <li>「コピー」して AI に貼ります。AI の回答は元の語に戻せます。</li>
      </ol>
      <button type="button" onClick={() => setText(SAMPLE_TEXT)}>サンプルの問合せメールで試す</button>
      <p className="hint">文章はこの端末の中だけで調べ、外には送りません。</p>
    </section>
  );
}
