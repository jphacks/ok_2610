import type { ImageSource } from '../../infra/image/image';
import type { PdfSource } from '../../infra/pdf/document';
import { useStore } from '../store';

/**
 * 画像の中に見つけた顔の一覧（Issue #11）。既定ではすべて塗りつぶし、顔ごとに「残す」を選べる。
 * 番号は、保存した画像に書くラベル「[顔1]」と同じ。
 */
export function FacesPanel({ source }: { source: ImageSource | PdfSource }) {
  const kept = useStore((s) => s.keptFaces);
  const setKeptFaces = useStore((s) => s.setKeptFaces);
  const where = (i: number) => {
    if (source.kind !== 'pdf') return '';
    const image = source.images[source.faces[i]!.image];
    return image ? `（${image.page + 1} ページの画像）` : '';
  };
  return (
    <fieldset className="field faces-panel" aria-label="画像の中の顔">
      <legend>画像の中の顔（{source.faces.length} 件）</legend>
      <p className="hint">
        ファイルとして保存するとき、チェックした顔を塗りつぶして「[顔1]」などと書きます。コピー・挿入する文章には影響しません。見逃した顔は、仕上がりの確認画面で四角形で囲んで隠してください。
      </p>
      {source.faces.map((_, i) => (
        <label key={i} className="check-line">
          <input
            type="checkbox"
            checked={!kept.includes(i)}
            onChange={(e) => setKeptFaces(e.target.checked ? kept.filter((k) => k !== i) : [...kept, i].sort((a, b) => a - b))}
          />
          [顔{i + 1}] を隠す{where(i)}
        </label>
      ))}
    </fieldset>
  );
}
