import { describe, expect, test } from 'vitest';
import { detectRules } from '../../src/core/detect/rules';
import { classifyDateRole } from '../../src/core/context/roles';

function found(text: string, category: string): string[] {
  const spans = detectRules(text).filter((s) => s.category === category);
  const unique = [...new Map(spans.map((s) => [`${s.start}:${s.end}`, s])).values()];
  return unique.map((s) => text.slice(s.start, s.end));
}

describe('直接識別子（FR-01）', () => {
  test('メール・電話・URL・郵便番号', () => {
    const t = '連絡先は taro@example.co.jp、090-1234-5678、(03)1234-5678、〒150-0001、https://example.com/a です。';
    expect(found(t, 'email')).toEqual(['taro@example.co.jp']);
    expect(found(t, 'phone')).toEqual(['090-1234-5678', '(03)1234-5678']);
    expect(found(t, 'postalCode')).toEqual(['150-0001']);
    expect(found(t, 'url')).toEqual(['https://example.com/a']);
  });
  test('全角の数字でも検出し、原文の位置で返す', () => {
    const t = '電話は０９０－１２３４－５６７８です';
    expect(found(t, 'phone')).toEqual(['０９０－１２３４－５６７８']);
  });
  test('注文番号はラベルの後ろの値だけを範囲にする', () => {
    expect(found('注文番号：AB-20261003-1182', 'orderNumber')).toEqual(['AB-20261003-1182']);
  });
  test('カード番号は Luhn が通るものだけ', () => {
    expect(found('カード 4111 1111 1111 1111', 'creditCard')).toEqual(['4111 1111 1111 1111']);
    expect(found('番号 1234 5678 9012 3456', 'creditCard')).toEqual([]);
  });
});

describe('人名', () => {
  test('敬称の前の名前を拾い、役職や一般名詞は拾わない', () => {
    const t = '担当の田中さんと、部長の山田様、お客様、店員さん、皆様に連絡しました。';
    expect(found(t, 'personName')).toEqual(['田中', '山田']);
  });
  test('読み仮名つき・自己紹介・カタカナ（長音符を含む）', () => {
    expect(found('田中花子（たなかはなこ）様', 'personName')).toEqual(['田中花子（たなかはなこ）']);
    expect(found('私は佐藤と申します。', 'personName')).toEqual(['佐藤']);
    expect(found('ジョーンズさんから', 'personName')).toEqual(['ジョーンズ']);
  });
});

describe('組織・店舗・地域', () => {
  test('長音符を含む社名を途中で切らない（前のツールで漏れた）', () => {
    expect(found('株式会社ABCソリューションズは', 'orgName')).toEqual(['株式会社ABCソリューションズ']);
  });
  test('店舗名は拾い、「当店」「来店」などは拾わない', () => {
    expect(found('渋谷店で購入し、当店に来店しました', 'store')).toEqual(['渋谷店']);
  });
  test('在住・都道府県・市', () => {
    expect(found('横浜市在住です', 'place')).toContain('横浜市');
    expect(found('神奈川県の都市部', 'place')).toEqual(['神奈川県']);
  });
});

describe('機微・機密（FR-03, FR-04）', () => {
  test('APIキーとパスワード', () => {
    const t = 'キーは sk-proj-abcdefghijklmnopqrstuvwx、パスワード: hunter22 です';
    expect(found(t, 'credential')).toEqual(['sk-proj-abcdefghijklmnopqrstuvwx', 'hunter22']);
  });
  test('健康・障害の語', () => {
    expect(detectRules('車椅子を利用し、持病があります').filter((s) => s.category === 'sensitive').map((s) => s.sensitiveKind)).toEqual(['health', 'disability']);
  });
});

describe('日付の役割（FR-06, AT-03）', () => {
  const role = (t: string, d: string) => classifyDateRole(t, t.indexOf(d), t.indexOf(d) + d.length).role;
  test('生年月日・業務日・診療日を区別する', () => {
    expect(role('生年月日：1958年4月12日', '1958年4月12日')).toBe('birthDate');
    expect(role('10月3日に御社の渋谷店で購入しました。', '10月3日')).toBe('businessDate');
    expect(role('納期は11月30日です', '11月30日')).toBe('businessDate');
    expect(role('9月1日に受診しました', '9月1日')).toBe('sensitiveDate');
  });
  test('手がかりがなければ要確認にする（黙って断定しない）', () => {
    const t = 'それは5月5日のことでした。';
    expect(classifyDateRole(t, 4, 8)).toMatchObject({ role: 'unknownDate', certainty: '要確認' });
  });
});
