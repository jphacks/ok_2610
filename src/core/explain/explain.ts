import { CATEGORY_INFO, categoryLabel, primaryCategory } from '../model/categories';
import type { Action, Candidate, Category, Explanation, Role } from '../model/types';

type Template = { problem: string; ifKept: string };

// 種別ごとの「問題になる状況」と「残すと何が起きうるか」（FR-14）
const TEMPLATES: Record<Category, Template> = {
  personName: { problem: '氏名はそれだけで本人を特定できます。', ifKept: '外部のAIサービスに本人の名前と相談内容が結び付いた形で渡ります。' },
  accountName: { problem: 'アカウント名から本人のSNSなどにたどり着けます。', ifKept: '公開されている投稿などと結び付けられる可能性があります。' },
  address: { problem: '住所は本人の自宅を特定できます。', ifKept: '自宅の場所が文章と一緒に外部へ渡ります。' },
  postalCode: { problem: '郵便番号は住んでいる地域をかなり狭く絞り込めます。', ifKept: '他の情報と組み合わせると居住地を特定しやすくなります。' },
  phone: { problem: '電話番号は本人に直接連絡できる情報です。', ifKept: '番号から本人を特定したり、連絡したりできます。' },
  email: { problem: 'メールアドレスは本人に直接連絡できる情報です。', ifKept: 'アドレスから本人や勤務先を推測できる場合があります。' },
  url: { problem: 'URLに個人や組織を特定できる情報が含まれることがあります。', ifKept: 'リンク先から本人や社内の情報にたどり着ける場合があります。' },
  ipAddress: { problem: 'IPアドレスから接続元の組織や地域を推測できます。', ifKept: '接続元のネットワークを特定できる場合があります。' },
  myNumber: { problem: 'マイナンバーは法律で取扱いが厳しく制限された番号です。', ifKept: '本人を一意に特定できる番号が外部へ渡ります。' },
  idNumber: { problem: '公的な番号は本人を一意に特定できます。', ifKept: '本人確認書類の番号が外部へ渡ります。' },
  creditCard: { problem: 'カード番号は不正利用につながります。', ifKept: '決済に使える情報が外部へ渡ります。' },
  bankAccount: { problem: '口座番号は金融機関の情報と組み合わせると本人の口座を特定できます。', ifKept: '振込先などの金融情報が外部へ渡ります。' },
  orderNumber: { problem: '注文番号は社内の記録と照合すると本人を特定できます。', ifKept: '社内の顧客記録と結び付けられる番号が外部へ渡ります。' },
  customerId: { problem: '会員番号は社内の記録と照合すると本人を特定できます。', ifKept: '顧客の記録と結び付けられる番号が外部へ渡ります。' },
  orgName: { problem: '勤務先や取引先の名前は、他の情報と組み合わさると人物を絞り込む手がかりになります。', ifKept: '組織名と出来事から、関係者を推測される場合があります。' },
  store: { problem: '店舗名は場所を示し、利用者の生活圏を絞り込む手がかりになります。', ifKept: '店舗・時期・特徴が揃うと、店員などの関係者が本人を思い当たる場合があります。' },
  place: { problem: '地域は単独では特定しにくいものの、他の情報と組み合わさると絞り込みに使えます。', ifKept: '年齢や出来事と組み合わさると、該当する人が少なくなります。' },
  date: { problem: '日付は役割によって扱いが変わります。', ifKept: '出来事の時期と他の情報が揃うと、人物を絞り込める場合があります。' },
  age: { problem: '年齢は他の情報と組み合わさると絞り込みに使えます。', ifKept: '地域や勤務先と組み合わさると、該当する人が少なくなります。' },
  gender: { problem: '性別は単独では特定しにくいものの、組合せの手がかりになります。', ifKept: '他の属性と組み合わさると、該当する人が少なくなります。' },
  department: { problem: '部署名は勤務先と組み合わさると、所属する人を絞り込めます。', ifKept: '少人数の部署では本人を推測される場合があります。' },
  position: { problem: '役職は勤務先と組み合わさると、本人を特定できる場合があります。', ifKept: '「この会社のこの役職」で本人が分かる場合があります。' },
  rareTrait: { problem: '「唯一の」「いつも同じ」のような表現は、該当する人を一気に絞り込みます。', ifKept: '少ない手がかりでも本人が分かる場合があります。' },
  sensitive: { problem: '健康・障害・家庭の事情などは、知られると本人に不利益が生じやすい情報です。', ifKept: '本人の慎重に扱うべき事情が外部へ渡ります。要約に必要かどうかを確認してください。' },
  credential: { problem: 'パスワードやAPIキーは、それだけで不正アクセスにつながります。', ifKept: '認証情報が外部へ渡ります。出力前に必ず取り除いてください。' },
  confidential: { problem: '価格・契約条件・未公表の情報は、組織の機密に当たる場合があります。', ifKept: '組織の規則によっては外部へ出せない情報です。' },
  custom: { problem: '利用者がカスタム辞書で指定した語です。', ifKept: '指定した語がそのまま外部へ渡ります。' },
  orgTerm: { problem: '組織の辞書で指定された語です。', ifKept: '組織が外部へ出さないと定めた語が渡ります。' },
};

const ROLE_TEXT: Record<Role, string> = {
  birthDate: '生年月日と判断しました。年齢が分かり、他の情報と組み合わさると本人を絞り込めます。',
  businessDate: '注文日や配達日などの業務上の日付と判断しました。要約に必要なことが多いため、段階 A・B では残します。',
  sensitiveDate: '受診や入院などに関わる日付と判断しました。慎重に扱う情報と結び付くため、粒度を粗くします。',
  unknownDate: '日付の役割を判断できませんでした。生年月日か業務上の日付かを確認してください。',
  example: '例として書かれた日付の可能性があります。',
  quote: '引用の中の日付の可能性があります。',
};

function describeAction(a: Action): string {
  switch (a.kind) {
    case 'keep':
      return 'そのまま残す';
    case 'delete':
      return '削除する';
    case 'categoryLabel':
      return '種類を示すラベル（[電話番号1] など）に置き換える';
    case 'pseudonym':
      return '仮の名前（人物A など）に置き換え、同じ対象は同じ名前で表す';
    case 'partialMask':
      return `一部だけ隠す（末尾 ${a.visible} 文字が残るため、情報は一部残ります）`;
    case 'generalize':
      return {
        year: '年だけを残す',
        decade: '年代（1980年代 など）に広げる',
        month: '月単位に広げる',
        ageBand: '年齢帯（30代 など）に広げる',
        prefecture: '都道府県まで広げる',
        region: '地方（関東地方 など）まで広げる',
        industry: '業種（ある店舗、ある金融機関 など）に広げる',
        role: '役割名（管理職、担当者 など）に広げる',
        abstract: '抽象的な表現（健康上の事情 など）に置き換える',
      }[a.level];
    case 'replace':
      return `「${a.text}」に置き換える`;
  }
}

const ALTERNATIVES: Partial<Record<Category, Action[]>> = {
  personName: [{ kind: 'categoryLabel' }, { kind: 'delete' }],
  address: [{ kind: 'generalize', level: 'prefecture' }, { kind: 'generalize', level: 'region' }, { kind: 'categoryLabel' }],
  place: [{ kind: 'generalize', level: 'region' }, { kind: 'pseudonym' }, { kind: 'delete' }],
  date: [{ kind: 'keep' }, { kind: 'generalize', level: 'month' }, { kind: 'delete' }],
  age: [{ kind: 'keep' }, { kind: 'generalize', level: 'ageBand' }, { kind: 'delete' }],
  orgName: [{ kind: 'keep' }, { kind: 'pseudonym' }, { kind: 'generalize', level: 'industry' }],
  store: [{ kind: 'keep' }, { kind: 'pseudonym' }, { kind: 'generalize', level: 'industry' }],
  sensitive: [{ kind: 'keep' }, { kind: 'generalize', level: 'abstract' }, { kind: 'delete' }],
  phone: [{ kind: 'categoryLabel' }, { kind: 'partialMask', visible: 4 }, { kind: 'delete' }],
  orderNumber: [{ kind: 'categoryLabel' }, { kind: 'partialMask', visible: 3 }, { kind: 'delete' }],
};

export type ExplainContext = {
  ambiguousEntity: boolean;
  inExample: boolean;
  stage: string;
};

/** 項目ごとの理由を作る。根拠（検出の事実）と一般的な注意事項を分けて書く（FR-14） */
export function explain(c: Candidate, ctx: ExplainContext): Explanation {
  const category = primaryCategory(c.categories);
  const t = TEMPLATES[category];
  const why = [t.problem, ...c.evidence.map((e) => `根拠: ${e.detail}`)];
  if (c.role) why.push(ROLE_TEXT[c.role]);
  if (c.categories.length > 1) {
    why.push(`複数の種類に当たります（${c.categories.map(categoryLabel).join('・')}）。最も強い処理を採っています。`);
  }
  const notes: string[] = [];
  if (c.certainty === '要確認') notes.push('判断が分かれるため、確認をお願いします。');
  if (ctx.ambiguousEntity) notes.push('同じ名字の人物が複数いるため、別の人物として扱っています。同じ人なら統合してください。');
  if (ctx.inExample) notes.push('例や仮定として書かれた部分の可能性があります。');
  if (category === 'sensitive') notes.push('本人のことか、第三者や一般論のことかは判定していません。');
  if (c.action.kind === 'partialMask') notes.push('一部を隠しても、残った部分から推測される場合があります。');
  const aiInferred = c.sources.includes('nano');
  if (aiInferred) notes.push('この判断にはAIの推定を含みます（未検証）。');
  if (c.manual) notes.push('手動で処理を変更しています。');

  const alternatives = (ALTERNATIVES[category] ?? [{ kind: 'keep' }, { kind: 'categoryLabel' }, { kind: 'delete' }])
    .filter((a) => JSON.stringify(a) !== JSON.stringify(c.action))
    .map(describeAction);

  return {
    candidateId: c.id,
    what: `${CATEGORY_INFO[category].label}「${c.text}」→ ${describeAction(c.action)}`,
    why,
    ifKept: t.ifKept,
    alternatives,
    aiInferred,
    notes,
  };
}

export { describeAction };
