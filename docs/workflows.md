# Scene の組み立てと保存

[README に戻る](../README.md) · [LLM と LoRA 検索](llm.md) · [プロンプトデータ](prompt-data.md)

Scene のノードは、`scene_prompt` を受け取り、プロンプトや生成条件を加えて次へ渡します。Scene Prompt Expand が計画から 1 バッチを取り出し、プロンプト文字列、シード、潜在画像などを出力します。配線の最小例は [最初の画像を生成する](../README.md#最初の画像を生成する)を参照してください。

## このガイドの内容

- [ノードの役割](#ノードの役割)
- [Matrix の組み合わせ](#matrix-の組み合わせ)
- [Queue と Count](#queue-と-count)
- [ランダム分岐](#ランダム分岐)
- [プロンプトの編集と出力](#プロンプトの編集と出力)
- [Preset で再利用する](#preset-で再利用する)
- [モデルと LoRA](#モデルと-lora)
- [コールバック](#コールバック)
- [保存先と PNG](#保存先と-png)

## ノードの役割

| ノード | 用途 |
| --- | --- |
| Scene Prompt / Scene Prompt (LLM) | 直接入力や候補、LLM の生成結果をプロンプトに加える |
| Scene Matrix / Scene Prompt Merge | 行ごとの違いを作る／2 つの計画の全組み合わせを作る |
| Scene Prompt Queue / Count | 生成順と行の繰り返し／生成回数を決める |
| Scene Prompt Random Route Input / Output | 確率に従って 1 経路を選び、合流する |
| Scene Prompt Delete / Reverse / To Text | タグを削除する／正負を入れ替える／文字列で取り出す |
| Scene Path / Scene Empty Latent | 保存先の階層／幅・高さ・バッチサイズを設定する |
| Scene Apply Model / Scene Apply LoRA | 経路ごとのモデル／LoRA を指定する |
| Scene Preset Input / Output / Reference | Scene のまとまりを保存し、呼び出す |
| Scene Prompt Make Switch | Preset に渡すスイッチを設定する |
| Scene Prompt Callback | Scene 上の位置でコールバックを実行する |
| Scene Prompt Callback (Discord / Request / Desktop) | コールバックの送信先と内容を設定する |
| Scene Prompt Expand / Scene Save Image | 計画から生成条件を取り出す／PNG を保存する |

バッチサイズは 1 回の生成で作る画像数です。Count で増えるのは生成の回数なので、バッチサイズ 2、Count 3 なら 3 バッチ、計 6 枚を生成します。

## Matrix の組み合わせ

Scene Matrix の編集画面で **通常行を追加** し、行ごとのポジティブ・ネガティブ候補や直接入力を設定します。行名、有効・無効、順序、ファイル名への使用も編集でき、変更はその場で保存されます。上流に A/B、Matrix に X/Y があれば、`AX, AY, BX, BY` の順で生成します。独立した 2 計画を組み合わせる場合は Scene Prompt Merge も使えます。

**Preset行を追加** では、保存した Preset とそのスイッチを行として呼び出せます。Preset 自身の出力に、その行の候補や直接入力が加わります。

| 上流 | Matrix の行 | 生成順 |
| --- | --- | --- |
| A/B | 通常行 X、Y/Z を出す Preset 行 | `AX, AY, AZ, BX, BY, BZ` |

Preset 行の Delete、Reverse、Callback は、まずその Preset 自身のプロンプトに作用し、その結果が上流と組み合わされます。Matrix の **スイッチ一式** 入力は、Preset 行ごとに対応を設定できます。連続生成には開始時の Preset とスイッチが使われます。

設定した行をすべて無効にすると 0 Scene になります。まだ行を作っていない Matrix は入力をそのまま通します。[ComfyUI-Custom-Scripts](https://github.com/pythongosssss/ComfyUI-Custom-Scripts) がある環境では、Matrix 行の入力でその補完機能も使えます。

## Queue と Count

Scene Prompt Queue は最大 10 個の Scene 入力をまとめます。**並び順** の **入力順** は各入力を最後まで生成してから次へ進み、**交互** は入力を順番に巡ります。**1行の回数** は、次の行へ進む前に同じ行を繰り返す回数です。

| 入力 | 設定 | 生成順 |
| --- | --- | --- |
| A、B（各 1 行） | 1行の回数：2 | `A, A, B, B` |
| A1/A2、B1/B2 | 入力順、1行の回数：2 | `A1, A1, A2, A2, B1, B1, B2, B2` |
| A1/A2、B1/B2 | 交互、1行の回数：2 | `A1, A1, B1, B1, A2, A2, B2, B2` |

Queue の **後続Count** は、後ろの Scene Prompt Count を適用するかを決めます。A/B 各 1 行を **1行の回数：2** でまとめ、その後ろに Count 10 を置くと、**乗算**（初期値）は `(A, A, B, B) × 10`、**固定** は `A, A, B, B` です。ただし固定でも後続の Count 0 は生成を止めます。Queue より前の Count による繰り返しは、この設定では変わりません。

Count の **後続Countを有効化** は初期状態で ON です。OFF にすると、その Count を適用した後、その経路では後続 Count を無視します。Count 0 も対象です。

| 接続 | 結果 |
| --- | --- |
| Count 10（OFF）→ Count 10 | 10 バッチ |
| Count 10（ON）→ Count 10 | 100 バッチ |
| A → Count 3（OFF）と B → Count 2（ON）を Queue → Count 10 | A は 3 回、B は 20 回 |

保護は Queue、Matrix、Merge、Preset を通っても経路ごとに維持されます。Queue 自身の行繰り返しと Matrix・Merge の組み合わせは適用されます。

すでに Queue を通った入力があると、後ろの Queue は受け取った順序を保つ合流点になります。途中に Scene Prompt、Reroute、Preset Reference があっても同じです。設定欄は無効になりますが値は維持され、上流の Queue をバイパスまたは切断すると再び使えます。ただし、ほかの有効な Queue やランダム分岐の合流が上流にある場合は無効のままです。

数値などの設定欄は ComfyUI の通常の方法で入力に変換できます。たとえば Integer ノードで Queue の回数を指定すると、Expand の合計も接続値に従って更新されます。

## ランダム分岐

Scene Prompt Random Route Input の **確率を設定** で、最大 10 出力の確率を 0.01% 刻み、合計 100% にします。確率がある出力には Scene 経路を接続し、Scene Prompt Random Route Output へ戻してから Count や Expand へつなぎます。0% の出力は未接続でもかまいません。

各回に 1 経路を選び、同じ潜在画像バッチ内の画像はその選択を共有します。合流後の Count 10 なら 10 回それぞれで抽選します。開始シードと生成番号が同じなら再現でき、分岐の入れ子も使えます。

分岐内には Prompt、Path、Delete、Reverse、Apply Model/LoRA、Callback を置けます。Count、Matrix、Empty Latent、Merge は合流後に置いてください。Preset 内も同様です。

## プロンプトの編集と出力

### 選択肢と重複タグ

波括弧で選択肢を書くと、Expand の実行時に開始シードと生成番号に基づいて 1 つ選びます。空の候補も確率に含むため、その `|` を省略しないでください。

| 記法 | 選ばれる内容 |
| --- | --- |
| `{A\|B}` | A、B がそれぞれ 1/2 |
| `{A\|}` | A、空文字がそれぞれ 1/2 |
| `{a\|\|}` | a が 1/3、空文字が 2/3 |

同じタグが重複すると、数値で明示した `(tag:weight)` の重みが最も大きい表記を残します。通常のタグは 1.0 として扱い、位置は最初の出現位置、同じ重みなら最初の表記を使います。正負は別々に整理し、両方にあるタグは重みにかかわらずネガティブを優先します。`(tag)`、`[tag]`、`(tag;1.4)`、`<lora:tag:1>` はそれぞれ別の表記です。

### Delete と Reverse

**Scene Prompt Delete** の `positive` にはポジティブから、`negative` にはネガティブから削除するタグを、カンマまたは改行で入力します。前後・連続する空白、大文字小文字、明示的な数値の重みを除いて完全一致で照合します。`bald` で `bald head` は消えず、後続ノードで同じタグを再追加することもできます。選択肢の枠は残り、`{bald|hair}` は `{|hair}`、`{bald||hair}` は `{||hair}` になります。

**Scene Prompt Reverse** の **全てのノード** はそこまでの全体、**直前のノード** は直前の Scene ノードが加えたプロンプトだけを入れ替えます。Path、Count、Empty Latent、Callback の直後では追加分がなく変化しません。Merge、Queue、Preset Reference、Reverse は、出力行全体を自身の内容として扱います。行順、回数、保存先などは変わりません。

### To Text と Expand の変換

**Scene Prompt To Text** は、現在の行を `positive` / `negative` の文字列で出力します。**全てのノード** は行全体、**直前のノードのみ** は直前の追加分です。構造をまとめるノードの直後では行全体、プロンプトを追加しないノードの直後では空文字になります。LoRA に設定したテキストは含みません。

通常のキュー追加では Expand と To Text が共通の新しい開始シードを使います。連続生成では実行する Expand の生成番号とシードに同期し、To Text 側の行数が少なければその行を循環して使います。

連続生成中は **停止** の下の **一時停止** で、実行中の生成・保存を待ってからモデルとキャッシュを解放します。**停止中...** が **再開** に変わったら、モデルを読み込み直して次の Scene から続けられます。開始時の計画、Preset、コールバックの実行状態は維持され、一時停止中はほかの待機中の連続生成も開始しません。**停止** は現在の連続生成を終了し、次の待機中の連続生成へ進みます。最後の生成中に一時停止を押した場合は、保存と完了時 Callback の後に GPU メモリを解放して終了します。

Expand の次の変換は互いに独立し、どちらも初期状態は OFF です。**モデル種別** を変えても自動では切り替わりません。変換後のプロンプトは CLIP、PNG メタデータ、コールバックに渡されます。

| 設定 | 内容 |
| --- | --- |
| _を空白に変換 | ASCII アンダースコアを空白にする |
| 強調値をAnima向けに変換 | 対応する 1.0〜1.5 の強調値を Anima 向けの範囲へ変換する。OFF にしても既存の値を逆変換しない |

## Preset で再利用する

よく使うまとまりを `Scene Preset Input → Scene Prompt / Matrix / Queue など → Scene Preset Output` として作り、Output に ID と名前を設定して **保存** します。保存対象はその Output につながる上流の経路だけです。編集用ワークフローに複数の Preset を置けますが、各 Preset には接続された Input と Output が 1 つずつ必要です。

Preset 内では Scene の計画用ノード、Scene Apply LoRA、入れ子の Scene Preset Reference、Scene 経路用の標準 If/Else Switch と対応する Boolean 制御を使えます。標準の Integer、Float、String、Boolean 定数も利用できます。画像生成・保存ノードや、外部ローダーにつながる Scene Apply Model は外側のワークフローに置きます。

通常のワークフローでは **Scene Preset Reference** で Preset を選び、後続の Scene ノードへ接続します。**Preset編集** は別タブで内容を開きます。Reference の **ファイル名付与**（初期状態 OFF）は、Preset 内のファイル名要素の後ろにその Reference のノード名を加えます。入れ子ごとに設定できます。

### スイッチを渡す

ComfyUI 標準の **If/Else Switch**（日本語表示は **スイッチ**、BETA）で Scene の経路を切り替えられます。追加処理を ON/OFF するなら、追加後の経路を `on_true`、元の経路を `on_false` につなぐ構成が基本です。

| ノード・操作 | 使い方 |
| --- | --- |
| Scene Preset Input | 10 個の Boolean と **スイッチ一式** を出力。**スイッチ名設定** で出力や Reference に表示する名前を付ける |
| Scene Prompt Make Switch | **スイッチ設定** で 10 個の名前と ON/OFF を設定し、**スイッチ一式** を Reference へ渡す。初期状態はすべて OFF |
| Reference の **スイッチ設定** | 各スイッチを ON、OFF、入力スイッチ 1〜10 のいずれかに割り当てる。複数を同じ入力にも対応させられる |

入力のスイッチ一式が未接続なら OFF として扱います。単独のスイッチだけなら標準の Boolean 入力も使えます。入れ子へ値を渡すときは、親 Input の **スイッチ一式** を子 Reference へ接続し、子側で対応を設定してください。接続なしでの継承はありません。

名前、ON/OFF、対応は編集と同時に反映され、Undo/Redo も使えます。連続生成は開始時の値を維持します。Reference ごとの LLM 生成結果は [Preset ごとの生成結果](llm.md#preset-ごとの生成結果)を参照してください。

## モデルと LoRA

**Scene Apply Model** にチェックポイントの MODEL、CLIP、VAE を接続し、Expand の前の Scene 経路に置きます。個別の拡散モデル、CLIP、VAE ローダーも接続できます。この構成では **Expand の MODEL → サンプラー、CLIP → テキストエンコード、VAE → VAE Decode** と接続します。選択された経路のローダーが評価されます。

**Scene Apply LoRA** は ComfyUI の `models/loras` にある LoRA を経路へ加えます。Apply Model/LoRA の `scene_prompt` は未接続でも使えます。Apply Model の MODEL・CLIP・VAE はローダーから接続してください。1 経路に Apply Model が複数あれば最後のモデルを使い、LoRA は経路内の順に適用します。

LoRA と Expand の **モデル種別** は `Illustrious`、`Anima`、`NoobAI`、`Pony` から選びます（初期値 `Illustrious`）。完全一致する LoRA と、その正負のテキスト・候補だけを適用します。一致しなければ元の MODEL と CLIP を使い、ファイル名からモデル種別を推測して変更することはありません。

### 選択とテキストの注入

**LoRAを選択** はローカルのファイルを検索する画面です。表示中の項目をハッシュで Civitai と照合し、一致すればモデル名と詳細ボタンを表示します。未登録を確認したものは **Local**、確認できていないものはファイル名と確認・再試行の操作を表示します。

**詳細確認** では Trigger Words と、取得できた Civitai のモデル・バージョン説明を読めます。Trigger Words や説明中のコードブロックの **注入** は、まだない語だけを **positiveテキスト** に追加します。既存の文、強調、選択済みの候補は保たれます。説明の取得に失敗しても Trigger Words の注入は使えます。

Expand の **生成情報** では現在つながる経路と Preset のモデル、CLIP、VAE、LoRA を確認できます。同じファイルと設定はまとめて表示し、LoRA の元ノード名も分かります。**Civitaiを確認** はチェックポイントまたは拡散モデルと LoRA の公開情報を調べます。この画面は現在の接続の一覧で、特定の生成結果のプロンプトやシードは表示しません。

検索・ダウンロードは [Civitai で LoRA を探す](llm.md#civitai-で-lora-を探す)を参照してください。

## コールバック

設定ノードの `callback` を **Scene Prompt Callback** へ接続し、そのノードを Scene の途中から Expand へつなぐと、指定位置で通知や HTTP リクエストを実行します。Preset 内や Scene の先頭にも置けます。Scene につながっていないものは実行せず、送信設定なしならそのまま通過します。計画の表示や回数の確認だけでは送信しません。

| 設定ノード | 設定内容 |
| --- | --- |
| Scene Prompt Callback (Discord) | Webhook URL、本文、任意の表示名 |
| Scene Prompt Callback (Request) | GET/POST、URL、本文、テキスト/JSON 形式、任意の JSON ヘッダー |
| Scene Prompt Callback (Desktop) | 通知のタイトルと本文 |

**実行頻度** の **初回** は連続生成中にそのノードで 1 回、**毎回** はその位置を通るたびに実行します。Expand がバッチのプロンプトを確定した後、画像生成の前に経路順で 1 つずつ送信します。タイムアウト秒数と、失敗時の **続行**（記録して先へ進む）／**停止** を設定できます。

GET は本文を使わず、クエリを URL に書きます。URL の変数はパーセントエンコードされます。JSON 本文では `{"content":"{all_positive}"}` のように文字列値の中へ変数を入れてください。

Desktop は生成を開始したブラウザー側のコンピューターに通知します。HTTPS または localhost で **デスクトップ通知を許可** を押し、ブラウザーの許可を与えてください。タブを閉じると通知できません。ブラウザーが通知の表示を報告した時点で完了します。

### Expand に直接つなぐ通知

設定ノードを Expand に直接つなぐと、次のタイミングで実行します。これらは固定の **10 秒** タイムアウトと Expand の **Callback失敗時** の設定を使い、Scene Prompt Callback の設定とは別です。

| 入力 | 実行するタイミング |
| --- | --- |
| 開始時Callback（`callback_first`） | 最初のバッチの画像生成前 |
| 毎回Callback（`callback_each`） | 毎バッチの画像生成前 |
| 完了時Callback（`callback_last`） | 最後のバッチの画像生成が成功した後 |

`callback_last` はエラー、中断、手動停止、ページ終了では実行しません。最後の通知の完了後に次の待機中の連続生成へ進みます。失敗設定が **続行** なら通信エラーを警告として次へ進み、**停止** なら後続の待機中の連続生成を自動開始しません。

### 本文の変数

`all` は連続生成全体ではなく **現在のバッチ** の最終結果です。

| 変数 | 内容 |
| --- | --- |
| `{current_positive}` / `{current_negative}` | この Callback の直前までに蓄積したプロンプト |
| `{all_positive}` / `{all_negative}` | 現在のバッチの最終ポジティブ／ネガティブ |
| `{current_node_names}` | この Callback より前で使った Scene ノードの表示名を `_` で連結 |
| `{all_node_names}` | 現在の経路全体で使った Scene ノードの表示名を `_` で連結 |
| `{exec_current_count}` / `{exec_total_count}` | 連続生成内の現在のバッチ番号（1 始まり）／合計バッチ数 |
| `{exec_replace_underscores}` | Expand の「_を空白に変換」が有効なら `true` |
| `{exec_anima_weights}` | Expand の「強調値をAnima向けに変換」が有効なら `true` |
| `{exec_model}` | Expand のモデル種別：`Illustrious`、`Anima`、`NoobAI`、`Pony` |
| `{exec_seed}` | 現在のバッチのシード |

ノード名に Callback、その設定ノード、Expand は含めません。未知の変数はその文字列のまま残します。

## 保存先と PNG

Scene Save Image の **保存パス** は ComfyUI の `output` 配下です。Expand の **タイムスタンプディレクトリ** と、**Scene Path** で加えた階層を組み合わせて保存します。必要なフォルダーは保存時に作られます。

### ファイル名

Expand の **ファイル名プレフィックス** が常に先頭に付きます。Scene Prompt、Matrix 行、Preset Reference の **ファイル名付与** で有効にした名前と、5 桁の連番を、**連番の位置** に従って連結します。初期値は **最後** です。

| 連番の位置 | プレフィックス `run_`、名前 `PromptA` の例 |
| --- | --- |
| 先頭 | `run_00001PromptA.png` |
| 最後 | `run_PromptA00001.png` |

区切り文字は自動で加わりません。必要な `_` などはプレフィックスや名前に含めてください。既存ファイルは上書きせず、次の番号を使います。

### メタデータと復元

Scene Save Image の **メタデータ保存** で、PNG に残す範囲を選びます。

| 設定 | 保存する内容 |
| --- | --- |
| ワークフロー全体（初期値） | 配置を含むワークフロー全体 |
| 生成経路ノードのみ | その画像に使った Scene 経路と画像生成ノード。配置を保ち、バイパス部分の接続をつなぎ直す |
| プロンプトのみ | ワークフローは保存しない。メタ情報が接続されていればプロンプトとシードを残す |

上の 2 つは PNG を ComfyUI にドラッグしてワークフローを復元できます。**プロンプトのみ** からは復元できません。

**Presetの中身を展開** は初期状態で OFF です。ON にすると、生成開始時の Preset を実際のノードと接続に置き換えて保存します。入れ子も対象です。全体保存ではキャンバス上の未接続 Reference も、経路のみの保存では使った経路だけを展開します。プロンプトのみでは効果がありません。
