import type { Category, CategoryGroup, EntityKind, QuasiType } from './types';

export type CategoryInfo = {
  label: string;
  group: CategoryGroup;
  /** 仮ラベルの接頭辞（同一対象をまとめる種別だけ） */
  pseudonymPrefix?: string;
  entityKind?: EntityKind;
  /** 組合せ評価で使う準識別子の種類 */
  quasi?: QuasiType;
};

export const CATEGORY_INFO: Record<Category, CategoryInfo> = {
  personName: { label: '氏名', group: 'direct', pseudonymPrefix: '人物', entityKind: 'person' },
  accountName: { label: 'アカウント名', group: 'direct' },
  address: { label: '住所', group: 'direct', quasi: 'residence' },
  postalCode: { label: '郵便番号', group: 'direct', quasi: 'residence' },
  phone: { label: '電話番号', group: 'direct' },
  email: { label: 'メールアドレス', group: 'direct' },
  url: { label: 'URL', group: 'direct' },
  ipAddress: { label: 'IPアドレス', group: 'direct' },
  myNumber: { label: 'マイナンバー', group: 'direct' },
  idNumber: { label: '識別番号', group: 'direct' },
  creditCard: { label: 'カード番号', group: 'direct' },
  bankAccount: { label: '口座番号', group: 'direct' },
  orderNumber: { label: '注文番号', group: 'direct' },
  customerId: { label: '会員番号', group: 'direct' },
  orgName: { label: '組織名', group: 'quasi', pseudonymPrefix: '組織', entityKind: 'org', quasi: 'organization' },
  store: { label: '店舗・拠点', group: 'quasi', pseudonymPrefix: '店舗', entityKind: 'place', quasi: 'store' },
  place: { label: '地域', group: 'quasi', pseudonymPrefix: '地域', entityKind: 'place', quasi: 'residence' },
  date: { label: '日付', group: 'quasi', quasi: 'time' },
  age: { label: '年齢', group: 'quasi', quasi: 'age' },
  gender: { label: '性別', group: 'quasi', quasi: 'gender' },
  department: { label: '部署', group: 'quasi', quasi: 'department' },
  position: { label: '役職', group: 'quasi', quasi: 'position' },
  rareTrait: { label: '特徴的な記述', group: 'quasi', quasi: 'rare' },
  sensitive: { label: '機微情報', group: 'sensitive', quasi: 'trait' },
  credential: { label: '認証情報', group: 'secret' },
  confidential: { label: '機密情報', group: 'secret' },
  custom: { label: '指定語', group: 'custom' },
  orgTerm: { label: '組織指定語', group: 'custom' },
};

export const ALL_CATEGORIES = Object.keys(CATEGORY_INFO) as Category[];

export function categoryLabel(category: Category): string {
  return CATEGORY_INFO[category].label;
}

/** 複数分類のうち、処理と表示に使う主分類。秘密 > 直接識別子 > 機微 > 準識別子 の順 */
const GROUP_RANK: Record<CategoryGroup, number> = { secret: 0, direct: 1, custom: 2, sensitive: 3, quasi: 4 };

export function primaryCategory(categories: Category[]): Category {
  const sorted = [...categories].sort((a, b) => GROUP_RANK[CATEGORY_INFO[a].group] - GROUP_RANK[CATEGORY_INFO[b].group]);
  const first = sorted[0];
  if (!first) throw new Error('categories が空です');
  return first;
}
