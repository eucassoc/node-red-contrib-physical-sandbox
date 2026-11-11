# node-red-contrib-physical-sandbox

Node-RED 向けの Physical Sandbox です。エディタのサイドバーに、現場の写真や動画の上にロボットを実寸で表示するペインを追加します。
ロボットは MQTT のメッセージ（`ps in`）や記録（`ps play`）で動きます。動かした内容は [PS.com](https://physicalsandbox.com) に記録として保存できます。

[English](README.md)

動作環境は Node-RED 4.1 以上、Node.js 20 以上です。このバージョンでは、ご自身の URDF を変換するとき（[このパソコンだけにあるロボット](#このパソコンだけにあるロボット)）を除き、Python も
[psbx](https://pypi.org/project/physical-sandbox/) も必要ありません。

## インストール

Node-RED のユーザーフォルダ（既定では `~/.node-red`）で実行してください。

```sh
cd ~/.node-red
npm i node-red-contrib-physical-sandbox
```

Node-RED を再起動すると、サイドバーに「PS」タブが加わり、パレットに「physical sandbox」の分類と `ps in`・`ps play` のノードが加わります。
このプラグインがフローをデプロイすることはなく、クリックなしに何かを実行することもありません。

## ペイン

サイドバーの「PS」タブを開きます。「別ウィンドウで開く」を押すと、別の画面に出せます。どちらも同じ現地・同じ動きを表示するので、片方でも、両方同時でも使えます。

- **背景**: 現場の写真か動画を選択します。ブラウザと `<userDir>/physical-sandbox/backgrounds/` にだけ置かれ、PS.com には送られません。
- **床**: 映像の上で、地面にある長方形の 4 つの角を 1 から 4 の順にクリックし、角 1→2 と角 2→3 の長さ（m）を入力して「決定」を押します。ロボットはこの床の上に実寸で置かれます。
- **ロボット**: 一覧は PS.com のカタログ、psbx のキャッシュ（`~/.cache/physical-sandbox`）、このパソコンのフォルダ（後述）から作られます。ロボットを床へドラッグすると、そこに置きます。PS.com に接続できないときは、このパソコンにあるロボットだけを表示します。
- **記録**: PS.com にある自分の記録（一覧の表示にはログインが必要です）、`handle/name` で指定した記録、このパソコンの記録ファイルを開けます。開いたら、再生・停止・頭へを操作できます。
- **動きの記録**: `ps in` から届いた動きは、届いた順にペインの記録として残ります。
- **保存**: 「上書き保存」は、開いている記録の次のバージョンを作ります。「新しい記録として保存」は、指定した名前で新しい記録を作ります。バージョンが上書きされることはありません。「エクスポート」は、記録ファイルを `<userDir>/physical-sandbox/exports/` に書き出します。
- **エージェントのスイッチ**: 「エージェントに映像を渡す」は既定では切で、今は何も起こりません。今後のバージョンで使います。

## `ps in`: MQTT からペインへ

`mqtt in`（トピック `ps/#` か、より狭いもの）の後ろに `ps in` を置いてください。`ps/<site>/<id>/<kind>`（`<kind>` は `state`・`command`・`event`）のメッセージで、payload が `at`（ミリ秒）を持つ JSON であれば、ペインのロボットが動き、記録にも残ります。
payload はオブジェクト・JSON の文字列・Buffer のどれでもよいため、`mqtt in` の出力の設定はどれでも使えます。それ以外の payload はエラーにならず無視します。現地（Site）を指定すると、その現地のメッセージだけを通します。ブローカーが保持していたメッセージ（retain）はロボットを動かしますが、記録には残しません。メッセージは変更せずに出力へ送ります。

state の例は `{ "at": 1700000000000, "joints": { "shoulder": 0.5 }, "position": [x, y, z], "yaw": 0.2 }` です。`joints` と `position` のどちらか一方は必要です（単位は m、座標は ROS）。物は `{ "at": …, "type": "item", "parent": "site", "xyz": [x, y, z] }` です。記録に残るのは state だけです。

## `ps play`: 記録から MQTT へ

`ps play` は、記録の動きを `ps/<site>/<id>/state` のメッセージとして時間どおりに出力へ送り、ペインにも流します。記録は、ノードに貼り付けた JSON か、PS.com の記録（`handle/name` または `handle/name:バージョン`）です。
payload に `start`・`stop`・`rewind`、または `{"command": "start", "speed": 2, "loop": true}` を送って操作します。出力を `mqtt out` につなぐと送信でき、retain は `mqtt out` で設定します。

音楽や映像を合わせて始めるときは、音楽のノードにも同じ inject をつないでください。同じメッセージで同時に始まります。

`ps play` が再生した動きはペインの記録に残りません。ブローカーと `ps in` を通って戻ってきたメッセージも、ロボットは動かしますが、記録には残しません。

## このパソコンだけにあるロボット

ご自身のロボット（URDF）は、どこにも送らずに表示できます。psbx の main ブランチ（次のリリースで入ります。PyPI の 0.1.2 にはまだありません）で変換してください。

```sh
psbx machine bundle path/to/robot.urdf --out ~/robots/myarm --name myarm
```

そのフォルダを Node-RED の `settings.js` で指定します。

```js
physicalSandbox: {
  localMachineDirs: ['~/robots'],            // <name>/bundle.json を置いたフォルダ
  catalogBase: 'https://physicalsandbox.com', // 省略できます。環境変数 PS_CATALOG_URL が優先されます
  site: 'local',                              // 省略できます。ps/<site>/<id>/<kind> の現地
},
```

ロボットごとに、指定したフォルダの下に専用のフォルダを作ります（`--out` は `bundle.json` を書き出すフォルダです）。`~` はホームフォルダです。それ以外の相対パスは、ユーザーフォルダから見たパスになります。このようなロボットを使った記録は、PS.com にそのロボットがないため PS.com には保存できず、このパソコンに「PS.com 未保存」として残ります。

## PS.com へのログインと保存

ペインの「PS.com にログイン」を押すと、6 桁のコードと、開くアドレス（`<catalogBase>/vr`。既定は `https://physicalsandbox.com/vr`）が表示されます。そのアドレスを開いてコードを入力すると、ペインがログインした状態になります。トークンは `<userDir>/physical-sandbox/ps-com-token.json` に保存されます。

PS.com に接続できない（オフライン・ログインしていない・PS.com の障害）などで保存できなかったときは、記録を `<userDir>/physical-sandbox/unsent/` に残し、ペインに「PS.com 未保存」と「再送信する」ボタンを表示します。Node-RED を再起動しても残ります。上書き保存の対象が別の場所で変更されていたときは、その記録は新しい記録として保存され、ペインにその旨が表示されます。

## プライバシーと制限

- 背景の写真や動画は、このパソコンの外に出ません。PS.com に送られるのは記録（動きと現地のロボット）だけで、保存を押したときに限ります。
- Node-RED の `adminAuth` を有効にしているときは、ロボットのテクスチャを取得できません（形は表示されます）。

## 開発

```sh
npm install
npm run build
npm test            # Node-RED 4.1.x で試験します
npm run test:nr5    # Node-RED 5.0.x で起動の試験をします
npm run start:dev   # このパッケージを入れた Node-RED を http://127.0.0.1:1881 で起動します
```

`npm run start:dev -- <userDir>` とすると、新しい一時フォルダではなく指定したユーザーフォルダを使います。

## ライセンス

Apache License 2.0 です。[LICENSE](LICENSE) と [NOTICE](NOTICE) をご覧ください。
