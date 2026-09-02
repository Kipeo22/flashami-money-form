# flashami-money-form

旅行イベント向けの支出入力・集計Discord Botです。簡素なWeb管理画面から複数イベントを作成し、Discordのモーダルから入力した支出をGoogle Apps Script（GAS）経由でイベント別にGoogle SheetsとGoogle Driveへ保存します。

## MVPの動作

1. Web管理画面からイベント名、初期予算、Discordチャンネルを登録する
2. 管理者が登録したチャンネルで `/支出フォーム` を実行する
3. ユーザーが `支出を登録` を押す
4. モーダルで次を入力する
   - 誰が？（支払者）
   - 誰の分？（参加者、または `@運営`）
   - なにを？
   - 金額
   - レシート画像またはPDF
5. イベント専用Driveフォルダへレシート、Google Sheetsへ支出を保存する
6. イベント別の精算表と共通予算残高を自動更新する

個人立替・共通予算という区分は入力しません。「誰の分？」で設定済みの `@運営` ロールだけを選んだ支出を共通予算として扱います。

- 通常ユーザーを選択: 個人間精算へ含める
- `@運営` だけを選択: 共通予算の使用額へ含め、個人間精算から除外する
- `@運営` と通常ユーザーの混在: 入力エラー
- `@運営` 以外のロール: 入力エラー

## 精算ルール

- 対象者間で1円単位の均等割り
- 端数はDiscordユーザーID順に1円ずつ配分
- 同じイベント内の全支出を相殺して「誰が誰へいくら支払うか」を生成
- 共通予算は `初期予算 - 運営対象の支出 = 残額`
- Discord Interaction IDで二重登録を防止

## Google Sheets

起動時に次のシートを自動作成します。既に同名シートがある場合、ヘッダーが異なると安全のため起動を停止します。

| シート     | 内容                                                    |
| ---------- | ------------------------------------------------------- |
| `イベント` | イベント、初期予算、Discordチャンネル、Driveフォルダ    |
| `支出`     | イベントID、支払者、対象者、内容、金額、レシートURLなど |
| `精算`     | イベント別の「誰が誰へいくら支払うか」                  |
| `予算集計` | イベント別の初期予算、運営対象の使用額、残額            |

以前の単一イベント版で作成した `支出` シートはヘッダーを自動拡張します。イベントIDがない既存行は新しいイベント集計には含めません。

## 必要環境

- Node.js 24以上
- Discord Application / Bot
- Discordサーバー内の `運営` ロール
- GoogleアカウントとGoogle Apps Script
- 保存先のGoogleスプレッドシートとDriveフォルダ

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
4. Discordの開発者モードを有効にし、Application ID、Server ID、運営Role IDを取得する
5. `.env` の次の値を設定する

```dotenv
DISCORD_TOKEN=ローカルで設定
DISCORD_CLIENT_ID=Application ID
DISCORD_GUILD_ID=Server ID
OPERATIONS_ROLE_ID=運営Role ID
```

BotトークンはGit、Discordメッセージ、チャットへ貼り付けないでください。

### 3. Google

BotはGoogle APIへ直接接続せず、GAS Webアプリへ署名付きHTTPSリクエストを送ります。サービスアカウント鍵やOAuthリフレッシュトークンは不要です。

#### 3-1. 保存先を用意する

GASを所有するGoogleアカウントから編集できる、次の2つを用意します。

1. 空のGoogleスプレッドシート
2. レシート保存先のGoogle Driveフォルダ

会社Sheetsと個人Driveを組み合わせる場合は、GAS所有者のアカウントへ両方の編集権限を付けてください。会社の外部共有ポリシーで許可されない場合は、会社アカウントでGASを作り、会社Driveを保存先にします。

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
| `SPREADSHEET_ID`  | 保存先スプレッドシートID             |
| `DRIVE_FOLDER_ID` | レシート親フォルダID                 |
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
4. 保存先スプレッドシートに `イベント`、`支出`、`精算`、`予算集計` が作られたことを確認する

以前の単一イベント版のスプレッドシートも、従来どおりヘッダーを自動拡張します。

#### 3-5. Webアプリとしてデプロイする

1. GAS右上の「デプロイ」→「新しいデプロイ」
2. 種類は「ウェブアプリ」
3. 「次のユーザーとして実行」は `自分`
4. 「アクセスできるユーザー」は `全員`
5. 「デプロイ」を押し、末尾が `/exec` のWebアプリURLをコピーする

会社のGoogle Workspaceで「全員」を選択できない場合、管理者ポリシーにより匿名Webアプリが禁止されています。このBotから利用するには、管理者に許可を相談するか、利用可能な別アカウントでGASを所有してください。

GASコードを更新したときは、「デプロイを管理」から新しいバージョンへ更新します。テスト用の `/dev` URLではなく、本番デプロイの `/exec` URLを使用してください。

#### 3-6. Botの `.env` を設定する

```dotenv
GAS_WEB_APP_URL=https://script.google.com/macros/s/デプロイID/exec
GAS_SHARED_SECRET=スクリプトプロパティと同じ秘密値
```

Botはリクエスト本文をHMAC-SHA256で署名します。GAS側では署名、有効時刻、リクエストの再利用、入力値を検証してからSheets／Driveを操作します。

### 4. コマンド登録と起動

管理画面用のユーザー名と12文字以上のパスワードも `.env` に設定します。

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

起動時に `GAS connection initialized` が表示されれば、GAS経由で初期化と集計更新まで完了しています。起動後、`http://127.0.0.1:3000` を開くとイベント作成・一覧画面を利用できます。イベントを作成してから、そのイベントに設定したDiscordチャンネルで `/支出フォーム` を実行してください。

1つのBotプロセスで複数イベントを管理するため、イベントごとの再デプロイは不要です。Botを停止するとDiscord入力と管理画面を利用できないため、運用時は常時起動できる環境が必要です。

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
