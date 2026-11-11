# node-red-contrib-physical-sandbox

Physical Sandbox for Node-RED. A pane in the editor's sidebar shows robots standing on a real site, at real
scale, over a photo or a video of that site. The robots are moved by MQTT messages (`ps in`) or by a record
(`ps play`), and what moved can be saved as a record on [PS.com](https://physicalsandbox.com).

[日本語](README.ja.md)

Requirements: Node-RED 4.1 or later, Node.js 20 or later. Nothing in this version needs Python or
[psbx](https://pypi.org/project/physical-sandbox/), except converting your own URDF (see
[Robots only this machine has](#robots-only-this-machine-has)).

## Install

In the Node-RED user directory (`~/.node-red` by default):

```sh
cd ~/.node-red
npm i node-red-contrib-physical-sandbox
```

Restart Node-RED. The sidebar gets a tab 「PS」, and the palette gets a category "physical sandbox" with the
nodes `ps in` and `ps play`. The plugin never deploys flows and never does anything without a click.

## The pane

Open the tab 「PS」 in the sidebar, or press 「別ウィンドウで開く」 (open in a separate window) to put it on
another screen. Both show the same scene and the same stream, so you can use either, or both at once.

- **Background.** Choose a photo or a video of the site. It stays in your browser and in
  `<userDir>/physical-sandbox/backgrounds/`; it is never sent to PS.com.
- **Floor.** Click the four corners of a rectangle on the ground in the picture (1 to 4, going round), enter
  the lengths of edges 1→2 and 2→3 in metres, and press 「決定」 (Decide). The robots are placed on this floor
  at real scale.
- **Robots.** The list is made from three places: the PS.com catalog, the psbx cache
  (`~/.cache/physical-sandbox`) and local folders (below). Drag a robot onto the floor to place it. Without a
  connection to PS.com, only the robots on this computer are listed.
- **Records.** Open one of your own records on PS.com (the list needs a sign-in), a record by `handle/name`, or
  a record file from this computer. Then play, stop or go back to the start.
- **Recording the stream.** States that arrive through `ps in` are kept as a record in the pane, as they come.
- **Saving.** 「上書き保存」 (Save) makes the next version of the record you opened. 「新しい記録として保存」
  (Save as a new record) makes a new record under a name you give. Versions are never written over.
  「エクスポート」 (Export) writes a record file to `<userDir>/physical-sandbox/exports/`.
- **The agent switch.** 「エージェントに映像を渡す」 is off and does nothing yet; it is for a later version.

## `ps in`: from MQTT into the pane

Put `ps in` after `mqtt in` (topic `ps/#`, or narrower). Messages on `ps/<site>/<id>/<kind>`, with `<kind>`
one of `state`, `command` or `event`, and a JSON payload with `at` in milliseconds, move the robots in the pane
and are recorded. The payload may be an object, JSON text or a Buffer, so any Output setting of `mqtt in`
works; anything else is ignored without an error. The optional Site filter passes only one site. A retained
message moves the robots but is not recorded. The message goes on to the node's output unchanged.

A state is `{ "at": 1700000000000, "joints": { "shoulder": 0.5 }, "position": [x, y, z], "yaw": 0.2 }` with at
least one of `joints` and `position` (metres, ROS axes), or for an item
`{ "at": …, "type": "item", "parent": "site", "xyz": [x, y, z] }`. Only states are kept in a record.

## `ps play`: from a record out to MQTT

`ps play` plays a record's motion in time as `ps/<site>/<id>/state` messages, on its output and in the pane.
The record is either JSON pasted into the node or a PS.com record (`handle/name` or `handle/name:version`).
Send it `start`, `stop` or `rewind` as the payload, or `{"command": "start", "speed": 2, "loop": true}`.
Wire its output to `mqtt out` to publish; retain is `mqtt out`'s setting.

To start music or a video together with it, wire the same inject to the music node as well: both start on the
same message.

What `ps play` plays is not recorded in the pane, and neither are its messages when they come back through a
broker and `ps in`; they still move the robots.

## Robots only this machine has

Your own robot (a URDF) can be shown without sending it anywhere. Convert it with psbx from the main branch
(the next release; 0.1.2 on PyPI does not have it yet):

```sh
psbx machine bundle path/to/robot.urdf --out ~/robots --name myarm
```

and tell Node-RED the folder in `settings.js`:

```js
physicalSandbox: {
  localMachineDirs: ['~/robots'],            // folders holding <name>/bundle.json
  catalogBase: 'https://physicalsandbox.com', // optional; $PS_CATALOG_URL wins
  site: 'local',                              // optional; the site in ps/<site>/<id>/<kind>
},
```

`~` is your home folder, and other relative paths are taken from the user directory. A record that uses such a
robot cannot be saved to PS.com (PS.com does not have the robot); it stays on this computer as 「PS.com 未保存」.

## PS.com: sign-in and saving

Press 「PS.com にログイン」 in the pane. It shows a 6-digit code; open `https://physicalsandbox.com/vr`, enter
the code, and the pane is signed in. The token is kept in `<userDir>/physical-sandbox/ps-com-token.json`.

If a save cannot reach PS.com (offline, signed out, PS.com failing), the record is kept in
`<userDir>/physical-sandbox/unsent/` and the pane shows 「PS.com 未保存」 with a button 「再送信する」 (Send
again). It survives a restart of Node-RED. If the record you saved over was changed elsewhere meanwhile, your
copy is saved as a new record and the pane says so.

## Privacy and limits

- The background photo or video never leaves this computer. Only the record (states and the scene's devices)
  goes to PS.com, and only when you save.
- When Node-RED's `adminAuth` is on, the textures of robots are not loaded (the shapes are).

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
