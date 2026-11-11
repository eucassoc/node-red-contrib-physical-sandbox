# node-red-contrib-physical-sandbox

Physical Sandbox for Node-RED: a pane in the editor's sidebar that shows robots on a real site, moved by
MQTT messages and records. Work in progress; nothing is published yet.

[日本語](README.ja.md)

## Development

```sh
npm install
npm run build
npm test            # against Node-RED 4.1.x
npm run test:nr5    # the smoke test against Node-RED 5.0.x
npm run start:dev   # Node-RED on http://127.0.0.1:1881 with this package installed
```

`npm run start:dev -- <userDir>` uses that user directory instead of a new temporary one.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
