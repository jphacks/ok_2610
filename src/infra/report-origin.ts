// 利用記録を送ってよいオリジン。ビルド時の環境変数 WXT_REPORT_ORIGIN で決まり、CSP の connect-src にも同じ値が入る
// （wxt.config.ts）。未設定のビルドでは記録を一切送らない。
export const REPORT_ORIGIN: string | undefined = (import.meta.env.WXT_REPORT_ORIGIN as string | undefined) || undefined;
