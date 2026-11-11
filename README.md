# ComfyUI Scene Prompt Tools

プロンプトの組み合わせ、生成順、画像サイズ、保存先をノードで組み立て、ComfyUI で順番に生成するためのカスタムノードです。共通のプロンプトを保ちながら衣装や構図を変えるなど、繰り返す作業をまとめられます。

## できること

- **候補を組み合わせる** — Scene Prompt と Scene Matrix で、共通部分と行ごとの違いを管理します。
- **生成順と回数を決める** — Queue、Count、ランダム分岐で、複数の Scene を順番に実行します。
- **設定を再利用する** — Preset に保存したノードのまとまりを呼び出し、スイッチで一部を切り替えます。
- **モデルと LoRA を使い分ける** — Scene ごとに適用し、必要なら LLM によるプロンプト生成や Civitai 検索も利用できます。
- **画像を整理して保存する** — 保存フォルダー、ファイル名、PNG に残すワークフローの範囲を指定します。

ここでいう **Scene** は、プロンプトや画像サイズなどをまとめた生成計画です。Scene のノード同士は `scene_prompt` で接続し、最後に **Scene Prompt Expand** で通常の ComfyUI の入力へ変換します。

## インストールと更新

ComfyUI の `custom_nodes` ディレクトリで次を実行します。

```bash
git clone https://github.com/norqis/ComfyUI-Scene-Prompt-Tools.git
```

追加の Python 依存パッケージをインストールする手順はありません。ComfyUI を再起動し、ブラウザーを再読み込みするとノードを使えます。

更新時は、`ComfyUI/custom_nodes/ComfyUI-Scene-Prompt-Tools` 内で次を実行してから、同じく ComfyUI の再起動とブラウザーの再読み込みを行ってください。

```bash
git pull
```

## 最初の画像を生成する

まずは、通常のチェックポイントを使った画像生成に Scene を接続します。**Load Checkpoint**（`CheckpointLoaderSimple`）、**CLIP Text Encode (Prompt)** 2 個、**KSampler**、**VAE Decode** に加え、次の 4 ノードを用意してください。以下では CLIP Text Encode (Prompt) を CLIP Text Encode と略します。

```text
Scene Prompt → Scene Empty Latent → Scene Prompt Expand
                                           ↓ メタ情報
                                     Scene Save Image
```

下表のとおりに接続します。CLIP Text Encode は、ポジティブ用とネガティブ用を 1 個ずつ使います。Scene Save Image の画像入力は VAE Decode から接続します。

| 接続元 | 接続先 |
| --- | --- |
| Scene Prompt：`scene_prompt` | Scene Empty Latent：`scene_prompt` |
| Scene Empty Latent：`scene_prompt` | Scene Prompt Expand：`scene_prompt` |
| Load Checkpoint：`MODEL` | KSampler：`model` |
| Load Checkpoint：`CLIP` | 両方の CLIP Text Encode：`clip` |
| Scene Prompt Expand：`ポジティブ` | ポジティブ用 CLIP Text Encode：`text` |
| Scene Prompt Expand：`ネガティブ` | ネガティブ用 CLIP Text Encode：`text` |
| ポジティブ用 CLIP Text Encode：`CONDITIONING` | KSampler：`positive` |
| ネガティブ用 CLIP Text Encode：`CONDITIONING` | KSampler：`negative` |
| Scene Prompt Expand：`シード` | KSampler：`seed` |
| Scene Prompt Expand：`潜在画像` | KSampler：`latent_image` |
| KSampler：`LATENT` | VAE Decode：`samples` |
| Load Checkpoint：`VAE` | VAE Decode：`vae` |
| VAE Decode：`IMAGE` | Scene Save Image：`画像` |
| Scene Prompt Expand：`メタ情報` | Scene Save Image：`メタ情報` |

KSampler の `seed` が数値欄になっている場合は、右クリックメニューから入力に変換して接続します。CLIP Text Encode の `text` も、接続端子がなければ同様に入力へ変換してください。

1. Load Checkpoint で、使うチェックポイントを選びます。KSampler の設定は、そのモデルで普段使う値にします。
2. Scene Prompt にポジティブとネガティブのプロンプトを入力します。候補データを用意していなくても、直接入力で試せます。
3. Scene Empty Latent で幅・高さを設定し、最初はバッチサイズを `1` にします。
4. ComfyUI の通常の生成操作でキューに追加し、1 Scene を生成します。画像は ComfyUI の `output` 配下に保存されます。

候補を増やすには、Scene Prompt と Scene Empty Latent の間に **Scene Matrix** を追加します。各行に異なる衣装や構図を設定すると、共通プロンプトとの組み合わせができます。すべてを順番に生成するには、Scene Prompt Expand の **連続生成** を押してください。通常のキュー追加では、選択中の 1 Scene を生成します。

連続生成を停止すると、実行中の画像を完了してから停止します。進行表示と画像プレビューは、開始したワークフローのタブに表示されます。

## 目的別の使い方

| やりたいこと | ガイド |
| --- | --- |
| Matrix、Queue、Count、Preset、モデル、保存方法を詳しく知る | [Scene の組み立てと保存](docs/workflows.md) |
| LLM の接続、プロンプト生成、Civitai 検索を使う | [LLM と LoRA 検索](docs/llm.md) |
| プロンプト候補、お気に入り、保存済みプロンプトを管理する | [プロンプトデータ](docs/prompt-data.md) |
| 開発環境を用意し、変更を確認する | [開発・変更の確認](CONTRIBUTING.md) |

## 困ったときは

**ノードが見つからない場合**は、配置が `ComfyUI/custom_nodes/ComfyUI-Scene-Prompt-Tools` になっているか確認し、ComfyUI の再起動とブラウザーの再読み込みを行ってください。

**候補が表示されない場合**は、[データの配置と形式](docs/prompt-data.md#データの配置と形式)を確認し、候補ポップアップの **設定再読み込み** を押してください。

**Preset が実行できない場合**は、**Preset編集** から開き、Input と Output の接続、および [Preset で使えるノード](docs/workflows.md#preset-で再利用する)を確認してください。

不具合や要望は [GitHub Issues](https://github.com/norqis/ComfyUI-Scene-Prompt-Tools/issues) へお寄せください。配布物と変更履歴は [Releases](https://github.com/norqis/ComfyUI-Scene-Prompt-Tools/releases)、利用条件は [MIT License](LICENSE) を参照してください。
