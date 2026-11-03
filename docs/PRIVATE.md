# 検証後の非公開化手順

1. **リポジトリを非公開にする**
   GitHub → `STONYGO/getback-clone` → Settings → General → 最下部の「Danger Zone」→ **Change repository visibility** → **Make private** → リポジトリ名を入力して確定する。
2. **GitHub Pagesを止める**
   無料プランでは、非公開にすると Pages は自動的に停止します。Pro以上のプランで Pages が残っている場合は、Settings → Pages →「Unpublish site」で止めます。
3. **配布済みファイルを確認する**
   Actions の Artifacts は既定で90日後に自動削除されます。すぐ消す場合は、Actions → 各実行 → Artifacts のゴミ箱アイコンで削除します。
4. **フォーク・クローンを確認する**
   Insights → Forks で第三者のフォークがないか確認します。公開中に取得されたコピーは回収できないため、必要に応じて記録を残します。
5. **配布したPCからアンインストールする**
   Windows は「設定 → アプリ」からアンインストールします。Mac はアプリをゴミ箱へ入れ、`~/Library/Application Support/<製品名>` を削除します。トレイの「ログイン時に自動起動」は、事前にオフにしておくと確実です。

非公開化した後も、Actions でのビルドは続けられます。ただし非公開リポジトリには無料枠（月2,000分。macOSは10倍で消費）があります。
