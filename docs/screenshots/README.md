# README用スクリーンショット

`scripts/capture-screenshots.js` がメモリ内の架空データとモックAIでアプリを起動し、3枚のPNGを生成します。実際の保存先やAI APIにはアクセスしません。`.env` を読み込まず実行してください。

撮影にはPlaywrightと対応するChromiumが別途必要です。アプリの実行依存には含めていません。

```sh
node scripts/capture-screenshots.js
```

Playwrightを別ディレクトリにインストールした場合は、`PLAYWRIGHT_MODULE` にその `index.mjs` の絶対パスを指定できます。`CHROME_PATH` でブラウザ実行ファイルを指定することもできます。

- `interview.png`: 設問に付随する任意のAI対話
- `results.png`: 架空の回答6件の集計
- `admin.png`: 管理一覧

サイズは1440×1100、表示言語は日本語です。撮影後に画像を確認し、READMEの相対リンクと合わせて更新してください。
