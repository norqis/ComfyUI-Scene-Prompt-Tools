# 開発・変更の確認

[README に戻る](README.md) · [使い方](docs/workflows.md) · [Issues](https://github.com/norqis/ComfyUI-Scene-Prompt-Tools/issues)

このページは開発用の手順です。カスタムノードを使うだけなら、[通常のインストール](README.md#インストールと更新)に追加の Python パッケージの導入は不要です。

## 開発環境

CI は Python **3.9 / 3.11** と Node.js **20** で確認します。リポジトリのルートで開発用の依存パッケージをインストールしてください。ComfyUI 本体の環境を変更せずに試すには、別の仮想環境を用意します。

```bash
python -m pip install "numpy<3" "Pillow<12" "coverage<8" "aiohttp>=3.9,<4"
npm ci
npx playwright install chromium
```

Linux でブラウザーのシステム依存も必要な場合は、CI と同じ `npx playwright install --with-deps chromium` を使います。

## 基本の確認

```bash
python -m compileall -q scene_prompt_tools tests __init__.py
coverage run --source=scene_prompt_tools -m unittest discover -s tests -v
coverage report -m
npm test
python tests/check_public_package.py
git diff --check
```

`npm test` はフロントエンドの構文確認とテストを実行します。個別には `npm run check:frontend`、`npm run test:frontend` を使えます。公開パッケージの検査は、配布対象や公開すべきでない内容などを確認します。CI の正確な構成は [ci.yml](.github/workflows/ci.yml)、実行項目は [package.json](package.json) を参照してください。

変更した操作の再現条件と確認結果を PR に記載してください。UI や生成経路の変更では、対象の操作、保存・再読み込み、必要に応じて Undo/Redo も実際に確認します。実行していない確認はその旨を明記します。

## 実際の ComfyUI での確認

次は実際の ComfyUI モジュールやブラウザーを使う追加確認です。通常のテストでは有効にしません。ComfyUI のソースと、その依存パッケージを導入した Python 環境を別に用意し、作業中の生成環境へ影響しない場所で実行してください。

| 環境変数 | 用途 |
| --- | --- |
| `COMFYUI_SOURCE` | 検査に使う ComfyUI のソースディレクトリ |
| `RUN_REAL_COMFYUI_SMOKE=1` | 実モジュールを使う検査を有効にする |
| `RUN_REAL_COMFYUI_HTTP_SMOKE=1` | HTTP 経由の実行検査を有効にする |
| `RUN_REAL_COMFYUI_BROWSER_SMOKE=1` | ブラウザー検査を有効にする |
| `COMFYUI_PYTHON` | ブラウザー検査で ComfyUI を起動する Python の実行ファイル |

PowerShell の例です。`<...>` は用意した検査用環境のパスに置き換えてください。

```powershell
$env:COMFYUI_SOURCE = '<ComfyUI のソースディレクトリ>'
$env:RUN_REAL_COMFYUI_SMOKE = '1'
$env:RUN_REAL_COMFYUI_HTTP_SMOKE = '1'
python -m unittest discover -s tests -p 'test_comfyui*.py' -v
```

ブラウザー検査は次のように実行します。

```powershell
$env:COMFYUI_PYTHON = '<ComfyUI 用 Python の実行ファイル>'
$env:RUN_REAL_COMFYUI_BROWSER_SMOKE = '1'
npm run test:real-comfy-browser
```

CI の ComfyUI smoke は固定した ComfyUI リビジョンで実行します。最新 ComfyUI との互換性検査は定期実行・手動実行時の別ジョブです。リビジョンと準備手順は [ci.yml](.github/workflows/ci.yml) を参照してください。
