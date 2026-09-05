# flashami-money-form

旅行イベント向けの支出入力・集計Discordアプリです。Vercel上のHTTPエンドポイントでDiscord Interactionsを受け取り、簡素なWeb管理画面から複数イベントを作成します。Discordのモーダルから入力した支出は、Google Apps Script（GAS）経由でイベント別にGoogle SheetsとGoogle Driveへ保存します。

常駐BotやDiscord Gateway接続は使用しません。Discordからリクエストが届いたときだけVercel Functionが起動するため、個人・非商用で利用条件を満たす場合はVercel Hobbyの無料枠で運用できます。

## MVPの動作

1. Web管理画面からイベント名、初期予算、Discordチャンネルを登録する
2. 運営が共通予算から事前に支払う費用は、Web管理画面の「運営の事前支出」からイベント、内容、金額を登録する
3. 参加者の立替は、ユーザーが登録済みチャンネルで `/支出登録` を実行する
4. 支出登録モーダルが開く
5. モーダルで次を入力する
   - 誰が？（支払者）
   - 誰の分？（参加者、または `@Flashami運営`）
   - なにを？
   - 金額
   - レシート画像またはPDF（任意）
6. 支出を指定した既存スプレッドシートの `収支・精算` タブへ保存し、レシートがある場合はイベント専用DriveフォルダとDiscordの登録結果にも添付する
7. 同じスプレッドシート内の精算結果と共通予算残高を自動更新する

個人立替・共通予算という区分は入力しません。「誰の分？」で設定済みの `@Flashami運営` ロールだけを選んだ支出を共通予算として扱います。

- 通常ユーザーを選択: 個人間精算へ含める
- `@Flashami運営` だけを選択: 共通予算の使用額へ含め、個人間精算から除外する
- `@Flashami運営` と通常ユーザーの混在: 入力エラー
- `@Flashami運営` 以外のロール: 入力エラー

Web管理画面の「運営支出を登録」は、Discordを開かずに共通予算の使用額を登録するためのフォームです。支払者と対象は `Flashami運営` として保存され、個人間精算には含まれません。現在、このフォームからのレシート添付には対応していないため、必要な場合はイベントのスプレッドシートへ後から追記します。

運営ロールIDは通常変更しない項目なので、新しいイベントを作成するフォーム内の「Discord詳細設定」に格納しています。運営ロールを作り直した場合は、詳細設定を開いて別のIDを指定できます。

集計は支出の保存後に自動更新します。支出明細の保存に成功して集計だけ失敗した場合や、スプレッドシートを手動修正した場合は、Basic認証で保護されたWeb管理画面の「集計を再計算」を使用します。参加者向けのDiscordコマンドには集計操作を表示しません。

## 精算ルール

- 対象者間で1円単位の均等割り
- 端数はDiscordユーザーID順に1円ずつ配分
- 同じイベント内の全支出を相殺して「誰が誰へいくら支払うか」を生成
- 共通予算は `初期予算 - 運営対象の支出 = 残額`
- Discord Interaction IDで二重登録を防止

## Google Sheets

管理用スプレッドシートには、BotがイベントとDiscordチャンネルの対応を管理する `イベント` シートだけを作成します。利用者向けのイベントスプレッドシートは新規作成せず、スケジュールや参加者がすでに記録されている既存ファイルを使用します。

Web管理画面でイベントを作成するときに既存スプレッドシートのURLまたはIDを指定します。GASは既存タブを変更せず、同じファイル内へ `収支・精算` タブを1枚追加します。

```text
既存のイベントスプレッドシート
├── スケジュール（既存・変更しない）
├── 参加者（既存・変更しない）
└── 収支・精算（Botが追加・更新）
```

`収支・精算` タブには次をまとめます。

- イベント名、初期予算、共通予算使用額、残額
- 支払者、対象者、内容、金額、レシートURLなどの支出記録
- イベント内で相殺した「誰が誰へいくら支払うか」

現行のDiscordフォームから登録するのは支出です。収入側は初期予算として表示し、追加収入の明細入力はまだ扱いません。

以前の中央管理方式で作成した `支出` シートがある場合、管理用の `イベント` シートへ各イベントの既存スプレッドシートIDを入力してから `setup` を実行すると、イベントIDが入っている支出行を対応する `収支・精算` タブへ移行します。元のシートは削除しません。

## 必要環境

- Node.js 24以上
- Discord Application / Bot
- Vercelアカウント
- Discordサーバー内の `運営` ロール
- GoogleアカウントとGoogle Apps Script
- イベント管理用Googleスプレッドシートと保存先Driveフォルダ

## セットアップ

### 1. インストール

```bash
npm install
cp .env.example .env
```

### 2. Discord

1. Discord Developer PortalでApplicationとBotを作成する
2. Botを対象サーバーへ追加する
3. サーバーに `運営` ロールを作成する
4. Discordの開発者モードを有効にし、Application ID、Public Key、Server ID、運営Role IDを取得する
5. `.env` の次の値を設定する

```dotenv
DISCORD_TOKEN=ローカルで設定
DISCORD_CLIENT_ID=Application ID
DISCORD_PUBLIC_KEY=General Informationに表示されるPublic Key
DISCORD_GUILD_ID=Server ID
OPERATIONS_ROLE_ID=運営Role ID
```

BotトークンはGit、Discordメッセージ、チャットへ貼り付けないでください。

### 3. Google

BotはGoogle APIへ直接接続せず、GAS Webアプリへ署名付きHTTPSリクエストを送ります。サービスアカウント鍵やOAuthリフレッシュトークンは不要です。

#### 3-1. 保存先を用意する

GASを所有するGoogleアカウントから編集できる、次の3つを用意します。

1. Botのイベント索引に使う空のGoogleスプレッドシート
2. イベント別のレシートフォルダを格納するGoogle Driveフォルダ
3. スケジュールや参加者が入っているイベントごとの既存スプレッドシート

GAS所有者のアカウントには、管理用スプレッドシート、各イベントの既存スプレッドシート、レシート保存先フォルダの編集権限が必要です。会社の外部共有ポリシーで許可されない場合は、会社アカウントでGASを作成します。

URLからそれぞれのIDを控えます。

```text
https://docs.google.com/spreadsheets/d/ここがSPREADSHEET_ID/edit
https://drive.google.com/drive/folders/ここがDRIVE_FOLDER_ID
```

#### 3-2. GASプロジェクトを作る

1. [Google Apps Script](https://script.google.com/)で「新しいプロジェクト」を作成する
2. `コード.gs` の内容を削除し、[`gas/Code.gs`](./gas/Code.gs) を貼り付ける
3. GASの「プロジェクトの設定」で「マニフェスト ファイルをエディタで表示する」を有効にする
4. `appsscript.json` を開き、[`gas/appsscript.json`](./gas/appsscript.json) の内容へ置き換える

#### 3-3. スクリプトプロパティを設定する

GASの「プロジェクトの設定」→「スクリプト プロパティ」へ次の3項目を追加します。

| プロパティ        | 値                                   |
| ----------------- | ------------------------------------ |
| `SPREADSHEET_ID`  | イベント管理用スプレッドシートID     |
| `DRIVE_FOLDER_ID` | イベント別レシートの親フォルダID     |
| `SHARED_SECRET`   | BotとGASだけが知る32文字以上の秘密値 |

秘密値はMacのターミナルで生成できます。

```bash
openssl rand -hex 32
```

この値は後で `.env` の `GAS_SHARED_SECRET` にも同じものを設定します。チャットやGitへ貼り付けないでください。

#### 3-4. GASを承認・初期化する

1. GASエディタ上部の関数一覧で `setup` を選ぶ
2. 「実行」を押す
3. GAS所有者のGoogleアカウントでSheets／Drive権限を承認する
4. 管理用スプレッドシートに `イベント` シートが作られたことを確認する

既存イベントを旧形式から移行する場合、最初の `setup` で管理用スプレッドシートへ `イベントスプレッドシートID` 列を追加した後、未入力イベントがあることを示すエラーで停止します。その列へ各イベントの既存ファイルIDを入力し、`setup` を再実行してください。新しいスプレッドシートファイルは作成されません。

#### 3-5. Webアプリとしてデプロイする

1. GAS右上の「デプロイ」→「新しいデプロイ」
2. 種類は「ウェブアプリ」
3. 「次のユーザーとして実行」は `自分`
4. 「アクセスできるユーザー」は `全員`
5. 「デプロイ」を押し、末尾が `/exec` のWebアプリURLをコピーする

会社のGoogle Workspaceで「全員」を選択できない場合、管理者ポリシーにより匿名Webアプリが禁止されています。このBotから利用するには、管理者に許可を相談するか、利用可能な別アカウントでGASを所有してください。

GASコードを更新したときは、「デプロイを管理」から新しいバージョンへ更新します。特に、このリポジトリのVercel対応版では支出とレシートを1回の通信で保存する `saveExpense` を使用するため、最新の [`gas/Code.gs`](./gas/Code.gs) を反映してから新しいバージョンへ更新してください。テスト用の `/dev` URLではなく、本番デプロイの `/exec` URLを使用します。

#### 3-6. Botの `.env` を設定する

```dotenv
GAS_WEB_APP_URL=https://script.google.com/macros/s/デプロイID/exec
GAS_SHARED_SECRET=スクリプトプロパティと同じ秘密値
```

Botはリクエスト本文をHMAC-SHA256で署名します。GAS側では署名、有効時刻、リクエストの再利用、入力値を検証してからSheets／Driveを操作します。

### 4. Vercelへ接続する

この手順で実際に公開操作を行うのは、Vercelを操作する担当者です。

1. このリポジトリをGitHubへ反映する
2. Vercel Dashboardで「Add New」→「Project」を開く
3. 対象リポジトリをImportする
4. Framework Presetは `Other`、Root Directoryはこのリポジトリのルートを指定する
5. Environment Variablesへ次を登録する

```dotenv
DISCORD_TOKEN=Discord Bot Token
DISCORD_CLIENT_ID=Discord Application ID
DISCORD_PUBLIC_KEY=Discord Application Public Key
DISCORD_GUILD_ID=対象Server ID
OPERATIONS_ROLE_ID=運営Role ID
GAS_WEB_APP_URL=https://script.google.com/macros/s/デプロイID/exec
GAS_SHARED_SECRET=GASのSHARED_SECRETと同じ値
ADMIN_USERNAME=admin以外の推測されにくい名前を推奨
ADMIN_PASSWORD=十分に長い管理パスワード
EVENT_NAME=旅行イベント
INITIAL_BUDGET_YEN=0
LOG_LEVEL=info
```

`WEB_HOST` と `PORT` はVercelでは設定しません。秘密値はGit、Discordメッセージ、チャットへ貼り付けないでください。

6. Deployを実行する
7. 発行されたURLの `/health` が `ok` を返すことを確認する
8. ルートURLを開き、Basic認証後にイベント管理画面が表示されることを確認する

```text
管理画面:             https://プロジェクト名.vercel.app/
稼働確認:             https://プロジェクト名.vercel.app/health
Discord Interactions: https://プロジェクト名.vercel.app/api/interactions
```

Vercel Functionsは東京リージョン `hnd1` で動作するように設定しています。DiscordのInteractionにはすぐ応答し、GAS保存は応答後に継続します。支出保存が完了した時点でDiscordのメッセージを更新し、時間のかかる全体集計はその後に実行します。

### 5. DiscordのInteractions Endpointを切り替える

1. Discord Developer Portalで対象Applicationを開く
2. 「General Information」を開く
3. 「Interactions Endpoint URL」に次を入力する

```text
https://プロジェクト名.vercel.app/api/interactions
```

4. 「Save Changes」を押す
5. Discordが署名確認用のPINGを送り、保存が成功することを確認する
6. ローカルの `.env` を設定した状態で、コマンド定義を登録する

```bash
npm run commands:register
```

Gateway方式とHTTP方式は同時には使えません。Interactions Endpoint URLを設定した後は、`npm run dev` を起動し続ける必要はありません。

### 6. ローカル確認

管理画面用のユーザー名と12文字以上のパスワードを `.env` に設定します。

```dotenv
WEB_HOST=127.0.0.1
PORT=3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=十分に長い管理パスワード
```

`WEB_HOST=127.0.0.1` では管理画面は起動したMacからだけ利用できます。外部公開する場合はTLSが有効な環境を使い、パスワードを別の安全な値へ変更してください。

```bash
npm run commands:register
npm run dev
```

起動後、`http://127.0.0.1:3000` を開くと管理画面を確認できます。`http://127.0.0.1:3000/health` は `ok` を返します。

ローカルでDiscord Interactionまで確認する場合は、HTTPSトンネルで `http://127.0.0.1:3000` を一時公開し、その `/api/interactions` をDiscord Developer Portalへ設定する必要があります。確認後は必ずVercelの本番URLへ戻してください。

1つのVercelプロジェクトで複数イベントを管理するため、イベントごとの再デプロイは不要です。イベント情報と支出はGAS側に保存し、Vercel Functionのメモリやローカルファイルには依存しません。

## 開発コマンド

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run check
```

## 現在の対象外

- イベント編集・終了操作
- 登録内容の編集・取消
- Discord OAuthログインと管理者権限連携
- 不均等割り、割合指定、金額指定
- 決済・送金処理
