/** 確認済みの加工後ファイルだけを渡すこと。保存後は端末のダウンロード先の管理下に入る */
export function saveFile(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // クリック直後に解放すると保存が始まらないことがあるので、少し待ってから解放する
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
