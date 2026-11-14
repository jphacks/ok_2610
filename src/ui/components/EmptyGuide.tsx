import { useStore } from '../store';
import { SAMPLE_TEXT } from '../sample';

/** 文章がまだないときの案内。画面の手順と同じ番号で流れを示し、サンプルで試せるようにする */
export function EmptyGuide() {
  const setText = useStore((s) => s.setText);
  return (
    <section className="empty-guide" aria-labelledby="empty-guide-title">
      <h2 id="empty-guide-title">AI に貼る前に個人情報を置き換えます</h2>
      <ol className="guide-steps">
        <li><span className="step-num" aria-hidden="true">1</span>文章やファイルを入れる</li>
        <li><span className="step-num" aria-hidden="true">2</span>置き換えた箇所を確認</li>
        <li><span className="step-num" aria-hidden="true">3</span>加工した文章を AI に渡す</li>
        <li><span className="step-num" aria-hidden="true">4</span>AI の回答を元の語に戻す</li>
      </ol>
      <button type="button" className="primary" onClick={() => setText(SAMPLE_TEXT)}>サンプルの問合せメールで試す</button>
      <p className="hint">文章は端末の外に送りません。</p>
    </section>
  );
}
