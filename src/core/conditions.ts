// 利用条件の確認（FR-16, UC-02）。回答は自己申告として扱い、「不明」を許可に変えない。

export type Answer = 'yes' | 'no' | 'unknown';

export type Question = {
  id: string;
  text: string;
  /** どちらの回答が「制約あり」に当たるか */
  restrictiveAnswer: Exclude<Answer, 'unknown'>;
  /** 不明・制約ありのときに確認する相手と事項 */
  consult: string;
};

export const QUESTIONS: Question[] = [
  {
    id: 'rules',
    text: '所属先に、生成AIの利用を禁止する規則がありますか？',
    restrictiveAnswer: 'yes',
    consult: '情報管理の担当部署に、生成AIの利用規則があるかを確認する',
  },
  {
    id: 'site',
    text: '使おうとしているAIサービス（とアカウント）は、所属先で利用が認められていますか？',
    restrictiveAnswer: 'no',
    consult: '承認済みのAIサービスとアカウントの一覧を、管理者に確認する',
  },
  {
    id: 'contract',
    text: 'この情報の持ち主（顧客など）との契約や同意で、外部サービスへの提供が制限されていますか？',
    restrictiveAnswer: 'yes',
    consult: '契約・プライバシーポリシーで外部委託や第三者提供の扱いを、法務や契約担当に確認する',
  },
  {
    id: 'classification',
    text: 'この文章は、社外秘・機密などの区分に当たりますか？',
    restrictiveAnswer: 'yes',
    consult: '文書の機密区分と、外部サービスでの扱いを、情報管理の担当部署に確認する',
  },
  {
    id: 'authority',
    text: 'この業務で、外部のAIサービスを使う判断をする権限がありますか？',
    restrictiveAnswer: 'no',
    consult: '上長や業務の責任者に、AIサービスを使ってよいかを確認する',
  },
];

export type ConditionsResult = {
  status: 'restricted' | 'unknown' | 'selfDeclaredOk' | 'unanswered';
  restricted: string[];
  consult: string[];
};

/**
 * 回答を評価する。「不明」は許可に変えず、確認事項の一覧を作る。
 * 結果は「自己申告で条件を確認済み」までで、「許可」とは表示しない（FR-17）。
 */
export function evaluateConditions(answers: Record<string, Answer | undefined>): ConditionsResult {
  const restricted: string[] = [];
  const consult: string[] = [];
  let unanswered = false;
  let unknown = false;
  for (const q of QUESTIONS) {
    const a = answers[q.id];
    if (!a) {
      unanswered = true;
      continue;
    }
    if (a === 'unknown') {
      unknown = true;
      consult.push(q.consult);
    } else if (a === q.restrictiveAnswer) {
      restricted.push(q.text);
      consult.push(q.consult);
    }
  }
  if (restricted.length > 0) return { status: 'restricted', restricted, consult };
  if (unknown) return { status: 'unknown', restricted, consult };
  if (unanswered) return { status: 'unanswered', restricted, consult };
  return { status: 'selfDeclaredOk', restricted, consult };
}
