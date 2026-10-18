// 画面文言。処理の事実と次の行動だけを書く（FR-17）。
// 「匿名化完了」「送信して安全」のような断定は使わない。tests/unit/messages.test.ts で禁止語を固定する。

export const MESSAGES = {
  checkDone: '設定した検査が完了しました',
  checkDoneWithIssues: '設定した検査が完了しました（未確認事項あり）',
  unresolved: '未確認事項あり',
  confirmed: '確認済みの加工文です',
  outputCopy: '加工文をコピー',
  outputInsert: '加工文を入力欄に挿入',
  outputFile: '加工文をファイルに保存',
  stopSending: '送信をやめる',
  copied: '加工文をコピーしました。この後はOSのクリップボードの管理下に入ります',
  inserted: '加工文を入力欄に挿入しました。送信はご自身で操作してください',
  noCandidates: '設定した検査では候補が見つかりませんでした。見逃しがないことの保証ではありません',
  analysisFailed: '解析できませんでした。低リスクという意味ではありません',
  outOfScope: 'この範囲は検査の対象外です',
  externalNotChecked: '外部の公開情報や連携先が持つ情報とは照合していません',
  noGuarantee: '法的な匿名性や、外部AIへ送ってよいかどうかは判定しません',
  sessionScope: '原文と対応表はこのパネルを閉じると消えます',
  clipboardNote: 'コピー後の扱いはOSとクリップボード同期の設定に従います',
  aiInferred: 'AI推定（未検証）',
  selfDeclared: '自己申告に基づく表示です',
} as const;

/** 画面に出してはいけない断定表現（FR-17） */
export const FORBIDDEN_PHRASES = ['匿名化完了', '匿名化済み', '送信して安全', '安全です', '安全に送信', '許可は不要', '問題ありません', '個人情報は含まれていません', '完全に保護'];
