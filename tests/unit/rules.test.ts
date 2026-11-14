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
  test('「〒」が読めない PDF: 住所の行のすぐ上の7桁の番号を郵便番号にする', () => {
    expect(found('0600001\n北海道札幌市中央区北一条西2-1', 'postalCode')).toEqual(['0600001']);
    expect(found('注文番号\n0600001\n発送済み', 'postalCode')).toEqual([]);
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

describe('PDF・画像から取り出した履歴書（見出しだけの行の次の行に値がある）', () => {
  test('「氏名」の次の行の氏名（ローマ字も）。ほかの見出しは氏名にしない', () => {
    expect(found('氏名\n佐伯　結衣\n生年月日', 'personName')).toEqual(['佐伯　結衣']);
    expect(found('氏名\nHoshino Yuma\n生年月日', 'personName')).toEqual(['Hoshino Yuma']);
    expect(found('氏名\n生年月日\n2000/05/03', 'personName')).toEqual([]);
  });
  test('「現住所」の次の行の住所を、建物名と部屋番号まで', () => {
    const t = '現住所\n〒202-0894　北海道青凪市旭が丘7丁目3番4号　メゾン青葉 309号室\n電話番号';
    expect(found(t, 'address')).toContain('北海道青凪市旭が丘7丁目3番4号　メゾン青葉 309号室');
    expect(found(t, 'postalCode')).toEqual(['202-0894']);
    expect(found('現住所\n同上', 'address')).toEqual([]);
  });
  test('見出しがなくても、建物名と部屋番号の間に空白がある住所', () => {
    expect(found('東京都霞丘市桜川5丁目3番18号 サンテラス桜川 501号室', 'address')).toContain('東京都霞丘市桜川5丁目3番18号 サンテラス桜川 501号室');
  });
  test('狭い欄で折り返された住所の続きの行', () => {
    const longest = (t: string) => found(t, 'address').sort((a, b) => b.length - a.length)[0];
    expect(longest('現住所\n〒525-6642 北海道朝凪野市新町6丁\n目24番13号 リバーサイド朝凪 506\n号室\n電話番号')).toBe('北海道朝凪野市新町6丁\n目24番13号 リバーサイド朝凪 506\n号室');
    expect(longest('〒595-0514 神奈川県月見原市青葉\n台7丁目11番17号 メゾン青葉 1103\n号室')).toBe('神奈川県月見原市青葉\n台7丁目11番17号 メゾン青葉 1103\n号室');
    expect(longest('京都府青凪市新町8丁目\n23番1号 ガーデン霞丘 901号室')).toBe('京都府青凪市新町8丁目\n23番1号 ガーデン霞丘 901号室');
    expect(longest('神奈川県風見野市花見\n台5丁目2番21号 リバーサイド朝凪\n907号室')).toBe('神奈川県風見野市花見\n台5丁目2番21号 リバーサイド朝凪\n907号室');
    // 住所の後の別の欄の行は続きにしない
    expect(longest('東京都港区芝公園4丁目2番8号\n電話番号\n0312345678')).toBe('東京都港区芝公園4丁目2番8号');
  });
  test('最寄り駅（欄の値・「〇〇駅から徒歩」）と、地名の付いた施設', () => {
    expect(found('最寄り駅・通勤時間\n日向森駅　徒歩4分', 'place')).toContain('日向森駅');
    expect(found('最寄り駅：JR中央線 三鷹駅', 'place')).toContain('三鷹駅');
    expect(found('自宅は桜台駅から徒歩5分です。各駅停車で通います', 'place')).toEqual(['桜台駅']);
    expect(found('月見原地域交流センターにて資料作成を担当', 'orgName')).toEqual(['月見原地域交流センター']);
    expect(found('近くの図書館と地域交流センターで勉強した', 'orgName')).toEqual([]);
  });
  test('地名の「が丘」を含む学校名を途中で切らない', () => {
    expect(found('2019 3 青凪市立旭が丘高等学校　卒業', 'orgName')).toEqual(['青凪市立旭が丘高等学校']);
  });
});

describe('組織・店舗・地域', () => {
  test('長音符を含む社名を途中で切らない（前のツールで漏れた）', () => {
    expect(found('株式会社ABCソリューションズは', 'orgName')).toEqual(['株式会社ABCソリューションズ']);
  });
  test('履歴書の職歴: 月の数字を社名にせず、ひらがなと「の」を含む社名を拾う', () => {
    expect(found('2024 5 株式会社さくらのデザイン（カフェ） 入社', 'orgName')).toEqual(['株式会社さくらのデザイン']);
    expect(found('株式会社さんの担当です', 'orgName')).toEqual([]);
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

describe('年齢は改行をまたがない', () => {
  test('表の別の欄の数字と「才」を年齢にしない', async () => {
    const { run } = await import('./helpers');
    const r = await run('2026\n4\n才\n満 22 才');
    const ages = r.candidates.filter((c) => c.categories.includes('age')).map((c) => c.text);
    expect(ages).not.toContain('4\n才');
    expect(ages).toContain('22 才');
  });
});
