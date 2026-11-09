// 文字の読み取り（Tesseract.js）の Worker の入口。本体（worker.min.js）を読む前に、害のない警告だけを捨てる。
//
// 日本語の学習データ（jpn.traineddata）には、旧方式のエンジン用の設定が入っている。同梱しているのは LSTM 専用の本体
// （tesseract-core-*-lstm）なので、読み込むたびに「Warning: Parameter not found: …」を console.error に出し、
// Chrome の拡張機能のエラー一覧に毎回並ぶ。読み取りの結果には影響しない。
// 本体は読み込んだときに console.error を取っておくので、本体より先に差し替える。ほかのメッセージはそのまま出す。
'use strict';
(() => {
  const error = console.error.bind(console);
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Warning: Parameter not found: ')) return;
    error(...args);
  };
})();
importScripts('worker.min.js');
