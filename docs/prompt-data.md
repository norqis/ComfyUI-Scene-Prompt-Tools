# プロンプトデータ

[README に戻る](../README.md) · [Scene の組み立てと保存](workflows.md) · [LLM と LoRA 検索](llm.md)

よく使うタグや文章を候補として保存すると、Scene Prompt、Matrix、LoRA の候補選択から再利用できます。候補データはカスタムノードのインストール先とは別に、ComfyUI のユーザーディレクトリへ置きます。

## データの配置と形式

配置先は `ComfyUI/user/<user>/scene_prompt_tools/data/` です。既定のローカルユーザーなら `<user>` は `default` になります。`custom_nodes/ComfyUI-Scene-Prompt-Tools/data/` は使いません。

フォルダーがカテゴリとその階層を表し、各候補ファイルの名前は **`prompt.json`** にします。

```text
ComfyUI/user/default/scene_prompt_tools/data/
├── 衣装/
│   └── 制服/
│       └── prompt.json
└── カメラ/
    └── prompt.json
```

ファイルの内容は JSON 配列です。`items` などのキーで包まず、次のように候補を並べます。

```json
[
  {
    "id": "summer_uniform",
    "label": "夏服の制服",
    "prompt": "school uniform, short sleeves, pleated skirt",
    "description": "半袖の夏服"
  },
  {
    "label": "ローアングル",
    "prompt": "low angle"
  }
]
```

| キー | 必須 | 内容 |
| --- | --- | --- |
| `label` | はい | 候補の表示名（文字列） |
| `prompt` | はい | プロンプトへ加える内容（文字列） |
| `id` | いいえ | 候補の識別子 |
| `description` | いいえ | 候補の説明 |

ファイルを編集したら、候補ポップアップの **設定再読み込み** を押して反映します。表示されない場合は、現在の ComfyUI ユーザー、フォルダー、ファイル名、JSON 配列の形式を確認してください。

## お気に入りと保存済みプロンプト

候補右上の **☆** を押すとお気に入りにできます。候補ポップアップの **検索** / **お気に入り** で切り替えて使います。お気に入りは同じ ComfyUI ユーザーのノード・ワークフロー間で共有し、ワークフローや PNG のメタデータとは別に保存されます。

Scene Prompt の画面から、保存済みプロンプトのコレクションも作成・管理できます。配置先は `data/保存済みプロンプト/<collection>/prompt.json` です。

## HTML の表から取り込む

リポジトリ内の `tools/import_scene_html.py` を使うと、HTML のプロンプト表を候補データへ変換できます。コマンドはリポジトリのルートで実行してください。

`--input` は **HTML ファイルを直接含むディレクトリ** を指定します。その直下の `*.html` が対象で、サブフォルダーの再帰探索や単一 HTML ファイルの指定はできません。`--output` は保存先の `data` ディレクトリです。

まず、書き込みをしない **`--dry-run`** で取込件数を確認します。以下のパスは、実際の入力・出力先に置き換えてください。

```bash
python tools/import_scene_html.py --input path/to/html-directory --output path/to/data --dry-run
```

結果を確認したら、既存候補に追加します。

```bash
python tools/import_scene_html.py --input path/to/html-directory --output path/to/data --merge
```

| オプション | 既存データの扱い |
| --- | --- |
| なし | 取込先の `prompt.json` が存在すると中止。既存ファイルは変更しない |
| `--merge` | 既存候補と統合し、重複を整理する |
| `--replace` | 取込対象の `prompt.json` を置換。対象外のファイルは残す |
| `--clean` | 出力ディレクトリ全体を取込結果で置き換える |
| `--dry-run` | 解析と件数表示だけ行い、書き込まない |

`--merge`、`--replace`、`--clean` は同時に指定できません。置換や全体の作り直しを行う場合は、必要な既存データを先に別の場所へ保存してください。取込後も **設定再読み込み** で画面に反映します。
