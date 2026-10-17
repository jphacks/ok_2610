// 判定の中核で使う型。UI・Worker・エンジンはこの型だけを共有する（ARCHITECTURE.md §4）

export type Category =
  // 直接識別子
  | 'personName'
  | 'accountName'
  | 'address'
  | 'postalCode'
  | 'phone'
  | 'email'
  | 'url'
  | 'ipAddress'
  | 'myNumber'
  | 'idNumber'
  | 'creditCard'
  | 'bankAccount'
  | 'orderNumber'
  | 'customerId'
  // 間接識別子（準識別子）
  | 'orgName'
  | 'store'
  | 'place'
  | 'date'
  | 'age'
  | 'gender'
  | 'department'
  | 'position'
  | 'rareTrait'
  // 機微・機密
  | 'sensitive'
  | 'credential'
  | 'confidential'
  // 利用者・組織が定義
  | 'custom'
  | 'orgTerm';

export type CategoryGroup = 'direct' | 'quasi' | 'sensitive' | 'secret' | 'custom';

/** 日付や記述の文脈上の役割（FR-06） */
export type Role =
  | 'birthDate'
  | 'businessDate'
  | 'sensitiveDate'
  | 'unknownDate'
  | 'example'
  | 'quote';

export type SensitiveKind = 'health' | 'disability' | 'family' | 'finance' | 'crime' | 'belief';

export type Source = 'rule' | 'dict' | 'custom' | 'ner' | 'nano' | 'manual';

export type Certainty = '確定' | '推定' | '要確認';

export type GeneralizeLevel =
  | 'year' // 1985年
  | 'decade' // 1980年代
  | 'month' // 2026年10月
  | 'ageBand' // 30代
  | 'prefecture' // 神奈川県
  | 'region' // 関東地方
  | 'industry' // 金融機関・店舗など
  | 'role' // 管理職・担当者
  | 'abstract'; // 健康上の事情

export type Action =
  | { kind: 'keep' }
  | { kind: 'delete' }
  | { kind: 'categoryLabel' }
  | { kind: 'pseudonym' }
  | { kind: 'partialMask'; visible: number }
  | { kind: 'generalize'; level: GeneralizeLevel }
  | { kind: 'replace'; text: string };

export type Evidence = {
  /** 根拠の種類。理由説明のテンプレートで使う */
  kind: 'pattern' | 'label' | 'checksum' | 'honorific' | 'vocabulary' | 'context' | 'model' | 'dictionary' | 'manual';
  /** 利用者に見せる短い説明（例:「直前に『注文番号』」） */
  detail: string;
};

/** エンジンが返す検出範囲。text は信用せず、統合時に原文から切り出す */
export type Span = {
  start: number;
  end: number;
  category: Category;
  source: Source;
  certainty: Certainty;
  evidence: Evidence[];
  /** 規則の確定度。統合の優先順位に使う（§5-2） */
  tier: SpanTier;
  sensitiveKind?: SensitiveKind;
  role?: Role;
  /** カスタム辞書で「語=>置換語」を指定したときの置換語 */
  forcedText?: string;
};

/** 統合の優先順位。数字が小さいほど優先 */
export type SpanTier = 0 | 1 | 2 | 3 | 4 | 5;
export const TIER = {
  certainRule: 0,
  orgDictionary: 1,
  customDictionary: 2,
  heuristicRule: 3,
  ner: 4,
  nano: 5,
} as const satisfies Record<string, SpanTier>;

export type Candidate = {
  id: string;
  start: number;
  end: number;
  /** 必ず原文.slice(start, end) */
  text: string;
  categories: Category[];
  role?: Role;
  sensitiveKind?: SensitiveKind;
  entityId?: string;
  forcedText?: string;
  sources: Source[];
  evidence: Evidence[];
  certainty: Certainty;
  action: Action;
  recommended: Action;
  /** 手動操作で処理が決まったか */
  manual: boolean;
  /** 加工後の文字列（keep のときは原文と同じ） */
  output: string;
};

export type EntityKind = 'person' | 'org' | 'place' | 'other';

export type Entity = {
  id: string;
  kind: EntityKind;
  /** 仮ラベル（人物A など） */
  label: string;
  /** 代表表記 */
  canonical: string;
  mentionIds: string[];
  userConfirmed: boolean;
};

export type QuasiType =
  | 'residence'
  | 'organization'
  | 'store'
  | 'time'
  | 'age'
  | 'gender'
  | 'department'
  | 'position'
  | 'trait'
  | 'rare';

export type RiskLevel = '情報' | '注意' | '要注意' | '評価不能';

export type RiskSuggestion = {
  /** 同じ語の全出現にまとめて適用する */
  candidateIds: string[];
  action: Action;
  /** 例:「手がかりが 3 → 2 に減ります」 */
  effect: string;
};

export type RiskFinding = {
  level: RiskLevel;
  /** 評価した範囲（段落番号。全体なら -1） */
  scope: number;
  attributes: { type: QuasiType; candidateId: string; text: string; weight: number }[];
  reasons: string[];
  suggestions: RiskSuggestion[];
};

export type CoverageStatus = '検査済' | '対象外' | '解析不能';

export type Coverage = {
  start: number;
  end: number;
  status: CoverageStatus;
  reason?: string;
};

export type Stage = 'A' | 'B' | 'C';

export type Purpose = 'summary' | 'reply' | 'classify' | 'rewrite';

/** 用途に応じて「残したい情報」（FR-15） */
export type KeepFlags = {
  relationships: boolean;
  dates: boolean;
  amounts: boolean;
  organizations: boolean;
};

export type EngineId = 'rule' | 'ner' | 'nano';

export type CustomTerm = { term: string; label?: string };

export type Settings = {
  stage: Stage;
  purpose: Purpose;
  keep: KeepFlags;
  /** 検査プロファイル: この確認単位で実行すると決めたエンジン（§10） */
  profile: EngineId[];
  customTerms: CustomTerm[];
  /** 同じセッションの過去の加工文を評価範囲に含めるか（FR-09） */
  includeHistory: boolean;
};

export type ManualOp =
  | { kind: 'add'; start: number; end: number; category: Category }
  | { kind: 'release'; start: number; end: number }
  | { kind: 'setAction'; start: number; end: number; action: Action }
  | { kind: 'setCategory'; start: number; end: number; category: Category }
  | { kind: 'resize'; start: number; end: number; newStart: number; newEnd: number }
  | { kind: 'mergeEntity'; from: string; into: string }
  | { kind: 'splitEntity'; start: number; end: number };

export type OpIssue = {
  opIndex: number;
  kind: 'rejected' | 'conflict';
  reason: string;
};

export type EngineStatus = {
  engine: EngineId;
  status: 'ok' | 'unavailable' | 'failed' | 'skipped';
  reason?: string;
  ms: number;
  spanCount: number;
};

export type Blocker = {
  kind: 'credential' | 'prohibited' | 'engineFailed' | 'uncovered' | 'policy' | 'recheck' | 'empty' | 'conditions';
  message: string;
};

export type RecheckFinding = {
  kind: 'residual' | 'newDetection' | 'labelCollision';
  text: string;
  category?: Category;
  message: string;
  blocking: boolean;
};

export type Explanation = {
  candidateId: string;
  what: string;
  why: string[];
  ifKept: string;
  alternatives: string[];
  /** Nano 由来の判断を含むか（「AI推定（未検証）」の表示に使う） */
  aiInferred: boolean;
  notes: string[];
};

export type StageRecommendation = {
  stage: Stage;
  reasons: string[];
};

export type OutputSegment =
  | { kind: 'plain'; text: string }
  | { kind: 'changed'; text: string; original: string; candidateId: string }
  | { kind: 'kept'; text: string; candidateId: string };

export type AnalysisResult = {
  text: string;
  candidates: Candidate[];
  entities: Entity[];
  risks: RiskFinding[];
  coverage: Coverage[];
  engines: EngineStatus[];
  explanations: Record<string, Explanation>;
  recommendation: StageRecommendation;
  masked: string;
  segments: OutputSegment[];
  recheck: RecheckFinding[];
  blockers: Blocker[];
  opIssues: OpIssue[];
  /** 入力・設定・手動操作・ポリシー版・検出器版・検査範囲から作る確認単位の ID（送信先は UI 側で合わせる） */
  contentId: string;
  /** 復元用の対応表（ラベル → 原文）。サイドパネルの外に出さない */
  restoreMap: Record<string, string>;
};
