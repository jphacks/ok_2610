// PDF.js の解析用 Worker。infra/pdf.ts が PDF を読むたびに起こし、読み終えたら止める（Issue #9）。
// 読み込むだけで PDF.js の Worker 側が自分の port で待ち受ける。
import 'pdfjs-dist/build/pdf.worker.min.mjs';
