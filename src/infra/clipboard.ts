/** 確認済みの加工文だけを渡すこと。コピー後は OS とクリップボード同期の管理下に入る（SF-03） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
