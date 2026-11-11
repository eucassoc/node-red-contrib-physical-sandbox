# node-red-contrib-physical-sandbox

Node-RED 向けの Physical Sandbox です。エディタのサイドバーに、現場の映像の上にロボットを表示するペインを追加します。
ロボットは MQTT のメッセージや記録で動きます。現在開発中で、まだ公開していません。

[English](README.md)

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
