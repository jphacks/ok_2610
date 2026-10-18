import { describe, expect, test } from 'vitest';
import { detectRules } from '../../src/core/detect/rules';
import { classifyDateRole } from '../../src/core/context/roles';
import { restoreLabels } from '../../src/core/restore';
import { entitiesToSpans, type NerToken } from '../../src/engines/ner-post';
import { run } from './helpers';

// 評価データ（text_cleaner_eval_10000）の dev で見つかった取りこぼし・誤検出を固定する

function found(text: string, category: string): string[] {
  const spans = detectRules(text).filter((s) => s.category === category);
  const unique = [...new Map(spans.map((s) => [`${s.start}:${s.end}`, s])).values()];
  return unique.map((s) => text.slice(s.start, s.end));
}

describe('直接識別子の表記揺れ', () => {
  test('電話番号の区切りが点・空白・市外局番の後の括弧', () => {
    expect(found('電話06.0510.4474まで', 'phone')).toEqual(['06.0510.4474']);
    expect(found('折り返しは03 0943 6765まで', 'phone')).toEqual(['03 0943 6765']);
    expect(found('携帯：06(0321)0446、', 'phone')).toEqual(['06(0321)0446']);
    expect(found('高橋(070) 0888-8150takahashi@mail.example', 'phone')).toEqual(['(070) 0888-8150']);
  });
  test('メールの前にくっついた電話番号を含めず、[at] 表記も拾う', () => {
    expect(found('(070) 0888-8150takahashi70@mail.example', 'email')).toEqual(['takahashi70@mail.example']);
    expect(found('メールはm.yamada [at] example.com宛て', 'email')).toEqual(['m.yamada [at] example.com']);
    expect(found('hanako＠example [dot] com宛て', 'email')).toEqual(['hanako＠example [dot] com']);
  });
  test('「郵便番号は」と、住所の見出しの後の〒', () => {
    expect(found('郵便番号は140-5277、住所は', 'postalCode')).toEqual(['140-5277']);
    const t = '現住所：〒621-1514 北海道札幌市中央区宮前8丁目5-12';
    expect(found(t, 'postalCode')).toEqual(['621-1514']);
    expect(found(t, 'address')).toContain('北海道札幌市中央区宮前8丁目5-12');
  });
  test('暗証番号の値に「です」を含めない', () => {
    expect(found('暗証番号は5564です。', 'credential')).toEqual(['5564']);
  });
  test('型番・商品コードは注文番号やカード番号にしない', () => {
    expect(found('型番KX-6698の部品を発注', 'orderNumber')).toEqual([]);
    expect(found('HM-2665とHM-284の互換性を確認', 'orderNumber')).toEqual([]);
    expect(found('商品コード4969242097667の在庫', 'creditCard')).toEqual([]);
  });
});

describe('住所・組織・店舗・部署', () => {
  test('町名・建物名のひらがな', () => {
    expect(found('兵庫県姫路市美しが丘6丁目21-18', 'address')).toEqual(['兵庫県姫路市美しが丘6丁目21-18']);
    expect(found('千葉県船橋市北野8丁目4-6ハイツみどり508号室。', 'address')).toEqual(['千葉県船橋市北野8丁目4-6ハイツみどり508号室']);
  });
  test('宛名だけの「お届け先：」は住所にしない', () => {
    expect(found('お届け先：山本裕子様', 'address')).toEqual([]);
  });
  test('ひらがなで始まる組織名と、名前の後に続く語', () => {
    expect(found('さくら内科クリニックを受診', 'orgName')).toEqual(['さくら内科クリニック']);
    expect(found('合同会社ソラリスの佐藤ですが', 'orgName')).toEqual(['合同会社ソラリス']);
    expect(found('株式会社という形態の特徴', 'orgName')).toEqual([]);
    expect(found('三つ葉商事株式会社訪問交通費', 'orgName')).toEqual(['三つ葉商事株式会社']);
  });
  test('店舗名の途中のひらがな。地名の「の」はまたがない', () => {
    expect(found('柏の葉店でソファを購入', 'store')).toEqual(['柏の葉店']);
    expect(found('那覇国際通り店の入口', 'store')).toEqual(['那覇国際通り店']);
    expect(found('神戸市の川崎工場へ', 'store')).toEqual(['川崎工場']);
  });
  test('部署名の前の社名・「先方」を含めない', () => {
    expect(found('株式会社北斗物産人事部の店長経験', 'department')).toEqual(['人事部']);
    expect(found('先方営業部の青木さん', 'department')).toEqual(['営業部']);
  });
  test('「村」で終わる姓を地名にせず、人名として拾う', () => {
    expect(found('中村めぐみ様', 'place')).toEqual([]);
    expect(found('「合同会社ソラリスの中村ですが」', 'personName')).toEqual(['中村']);
  });
  test('「問い合わせ番号」（「お」なし）', () => {
    expect(found('問い合わせ番号：8402-3260-9204', 'orderNumber')).toEqual(['8402-3260-9204']);
  });
});

describe('人名', () => {
  test('漢字の姓＋ひらがなの名、名義・フリガナのカタカナ', () => {
    expect(found('お届け先：中島あゆみ様', 'personName')).toEqual(['中島あゆみ']);
    expect(found('普通 1294045 名義 エンドウ クミコ', 'personName')).toEqual(['エンドウ クミコ']);
    expect(found('氏名：岡本大輔（オカモト ダイスケ）', 'personName')).toContain('オカモト ダイスケ');
  });
  test('「模様替え」「仕様」「皆さん様」「契約者〜様」', () => {
    expect(found('模様替えのため', 'personName')).toEqual([]);
    expect(found('仕様書の様式を多様な観点から', 'personName')).toEqual([]);
    expect(found('皆さん様、ご協力に感謝します', 'personName')).toEqual([]);
    expect(found('契約者青木千尋様の更新', 'personName')).toEqual(['青木千尋']);
  });
});

describe('句として拾う語', () => {
  test('稀な特徴は範囲を示す語ごと', () => {
    expect(found('社内最年少の医師', 'rareTrait')).toEqual(['社内最年少の']);
    expect(found('その職種で唯一の社員', 'rareTrait')).toEqual(['その職種で唯一の']);
    expect(found('支店で最古参のメンバー', 'rareTrait')).toEqual(['支店で最古参の']);
  });
  test('機微な語は修飾語ごと', () => {
    expect(found('持病の喘息で救急搬送', 'sensitive')).toEqual(['持病の喘息']);
    expect(found('がんの治療のため', 'sensitive')).toEqual(['がんの治療']);
    expect(found('ストーカー被害について', 'sensitive')).toEqual(['ストーカー被害']);
  });
  test('お金の動きを示す語の前の金額', () => {
    expect(found('9月11日に372万円を返金します', 'confidential')).toEqual(['372万円']);
  });
});

describe('日付の役割', () => {
  const role = (t: string, d: string) => classifyDateRole(t, t.indexOf(d), t.indexOf(d) + d.length).role;
  test('日付の直後の「生」と時刻', () => {
    expect(role('患者 橋本蓮、男性、2000/12/08生。糖尿病にて', '2000/12/08')).toBe('birthDate');
    expect(role('一次面接は3月15日の13時から。', '3月15日')).toBe('businessDate');
  });
  test('業務・機微な出来事の語を増やした', () => {
    expect(role('6月25日にうつ病で救急搬送。', '6月25日')).toBe('sensitiveDate');
    expect(role('糖尿病にて2025/12/14より加療中。', '2025/12/14')).toBe('sensitiveDate');
    expect(role('次回は9月15日。', '9月15日')).toBe('businessDate');
    expect(role('母が腰の手術のため、冷蔵庫の設置を8月10日にお願いしたい', '8月10日')).toBe('businessDate');
  });
});

describe('NER の後処理', () => {
  const tok = (index: number, word: string, entity: string): NerToken => ({ index, word, entity, score: 0.99 });
  test('空白で区切られた姓と名を1つにし、英数字はIDとして扱い、色の名前は外す', () => {
    const text = '名義 ササキ ユウコ、社員番号S58330、ネイビー';
    const spans = entitiesToSpans(text, [
      tok(1, '名義', 'O'),
      tok(2, '▁ササキ', 'PER'),
      tok(3, '▁ユウコ', 'PER'),
      tok(4, '、', 'O'),
      tok(5, '社員番号', 'O'),
      tok(6, 'S58330', 'PER'),
      tok(7, '、', 'O'),
      tok(8, 'ネイビー', 'ORG'),
    ]);
    expect(spans.map((s) => [text.slice(s.start, s.end), s.category])).toEqual([
      ['ササキ ユウコ', 'personName'],
      ['S58330', 'customerId'],
    ]);
  });
  test('ログの user= の値', () => {
    expect(found('ログ抜粋：user=kenta0412 ip=192.0.2.1', 'customerId')).toEqual(['kenta0412']);
  });
});

describe('復元', () => {
  test('AIが書き換えたラベルを一覧に出し、戻さない', () => {
    const map = { 人物A: '佐藤', '[電話番号1]': '090-1234-5678' };
    for (const w of ['人物Ａ', '人物 A', '人物a', 'Aさん', '電話番号1', '【電話番号1】', '[電話番号 1]', '［電話番号1］']) {
      const r = restoreLabels(`回答：${w}に連絡`, map);
      expect(r.restored).toBe(`回答：${w}に連絡`);
      expect(r.unmatched).toEqual([w]);
    }
  });
  test('戻した原文の語は書き換えの検査にかけない', () => {
    const r = restoreLabels('[電話番号1]に連絡', { '[電話番号1]': '電話番号1234' });
    expect(r.unmatched).toEqual([]);
  });
  test('一般化して出力に現れないラベルは対応表に入れない', async () => {
    const r = await run('株式会社青葉家具の柏の葉店で購入しました。');
    for (const label of Object.keys(r.restoreMap)) expect(r.masked).toContain(label);
  });
});
