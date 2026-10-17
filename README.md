# テキストクリーナー

[![IMAGE ALT TEXT HERE](https://jphacks.com/wp-content/uploads/2026/07/IMG_5316.png)](https://www.youtube.com/watch?v=piaNsc6ilBI)

## 製品概要
### 背景(製品開発のきっかけ、課題等）
### 製品説明（具体的な製品の説明）
### 特長
#### 1. 特長1
#### 2. 特長2
#### 3. 特長3

### 解決出来ること
### 今後の展望
### 注力したこと（こだわり等）
* 
* 

## 開発技術
### 活用した技術
#### API・データ
* 
* 

#### フレームワーク・ライブラリ・モジュール
* 
* 

#### デバイス
* 
* 

### 独自技術
#### ハッカソンで開発した独自機能・技術
* 独自で開発したものの内容をこちらに記載してください
* 特に力を入れた部分をファイルリンク、またはcommit_idを記載してください。

## 開発の始め方

```bash
npm install
# NER モデルを変換して配置（初回のみ。Python 3 が必要。数分かかります）
python3 -m venv .venv-ner && .venv-ner/bin/pip install "optimum[onnxruntime]" torch
.venv-ner/bin/python scripts/convert-ner.py
npm run setup:ner      # ONNX Runtime の WASM を同梱し、モデルのハッシュを確認

npm run dev            # 開発用の Chrome が拡張を読み込んだ状態で起動
npm run build          # .output/chrome-mv3 に本番ビルド（chrome://extensions で読み込む）
npm test               # ユニットテスト
npm run test:e2e       # ビルドして、拡張を読み込んだ Chromium で E2E テスト
npm run lint && npm run compile
```

設計は [ARCHITECTURE.md](ARCHITECTURE.md)、技術の選定理由は [TECH_SELECTION.md](TECH_SELECTION.md)、要件は [要件定義書](個人情報マスキング判断支援ツール_詳細要件定義書.md) を参照してください。
