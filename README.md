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

Restart Node-RED. The sidebar gets a tab "PS", and the palette gets a category "physical sandbox" with the
nodes `ps in` and `ps play`. The plugin never deploys flows and never does anything without a click.

## The pane

Open the tab "PS" in the sidebar, or press "Open in a window" to put it on
another screen. Both show the same scene and the same stream, so you can use either, or both at once.

The screens follow Node-RED's language setting (Japanese or English); messages to the agent stay in both languages.
The labels below are the English ones (the Japanese ones are in [README.ja.md](README.ja.md)).

- **Background.** Choose a photo or a video of the site. It stays in your browser and in
  `<userDir>/physical-sandbox/backgrounds/`; it is never sent to PS.com.
- **Floor.** Click the four corners of a rectangle on the ground in the picture (1 to 4, going round), enter
  the lengths of edges 1→2 and 2→3 in metres, and press "Decide". The robots are placed on this floor
  at real scale.
- **Robots.** The list is made from three places: the PS.com catalog, the psbx cache
  (`~/.cache/physical-sandbox`) and local folders (below). Drag a robot onto the floor to place it. Without a
  connection to PS.com, only the robots on this computer are listed.
- **Records.** Open one of your own records on PS.com (the list needs a sign-in), a record by `handle/name`, or
  a record file from this computer. Then play, stop or go back to the start (these play the open record
  again; only opening reads it). The pane shows the site ("Site") whose messages it takes: opening a record
  takes the record's site, and "Back to the plugin's site" goes back to the plugin's.
- **Recording the stream.** States that arrive through `ps in` are kept as a record in the pane, as they come.
- **Saving.** "Save" makes the next version of the record you opened. "Save as a new record" makes a new
  record under a name you give. Versions are never written over. "Export" writes a record file to `<userDir>/physical-sandbox/exports/`.
- **The agent switch.** "Share frames with the agent" is off by default and off again after a restart. While it is on, an agent connected through `ps-nodered-mcp` can ask for the pane's pictures (see "Claude Desktop" below).

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
psbx machine bundle path/to/robot.urdf --out ~/robots/myarm --name myarm
```

and tell Node-RED the folder in `settings.js`:

```js
physicalSandbox: {
  localMachineDirs: ['~/robots'],            // folders holding <name>/bundle.json
  catalogBase: 'https://physicalsandbox.com', // optional; $PS_CATALOG_URL wins
  site: 'local',                              // optional; the site in ps/<site>/<id>/<kind>
},
```

Each robot goes in its own folder under the configured folder (`--out` is the folder `bundle.json` is written into). `~` is your home folder, and other relative paths are taken from the user directory. A record that uses such a
robot cannot be saved to PS.com (PS.com does not have the robot); it stays on this computer as "Not on PS.com".

## PS.com: sign-in and saving

Press "Sign in to PS.com" in the pane. It shows a 6-digit code and the address to open (`<catalogBase>/vr`, which is
`https://physicalsandbox.com/vr` by default); enter the code there and the pane is signed in. The token is kept in `<userDir>/physical-sandbox/ps-com-token.json`.

If a save cannot reach PS.com (offline, signed out, PS.com failing), the record is kept in
`<userDir>/physical-sandbox/unsent/` and the pane shows "Not on PS.com" with a button "Send again". It survives a restart of Node-RED. If the record you saved over was changed elsewhere meanwhile, your
copy is saved as a new record and the pane says so. A copy that can never go (it uses a robot only this
computer has, or belongs to another account) can be taken away with "Remove" on its line.

## Claude Desktop

`ps-nodered-mcp` lets Claude Desktop (or any MCP client that starts a command) use the agent tools of the Node-RED running on this computer.

### Connecting Claude Desktop

Add this to Claude Desktop's configuration (`claude_desktop_config.json`) and restart it:

```json
{"mcpServers": {"node-red-physical-sandbox": {"command": "npx", "args": ["-y", "-p", "node-red-contrib-physical-sandbox", "ps-nodered-mcp"]}}}
```

(If the package is installed, `"command"` can be the path of the `ps-nodered-mcp` bin instead.) Node-RED must be running with this package installed, and the Node-RED editor open in a browser tab for the tools that need it (flows, pane pictures).

Options (add them to `args` after `ps-nodered-mcp`):

- `--url <address>`: the MCP route of Node-RED. Default `http://127.0.0.1:1880/physical-sandbox/mcp`; also `PS_NODERED_URL`. When Node-RED's settings set `httpAdminRoot`, the address must include it (for example `http://127.0.0.1:1880/admin/physical-sandbox/mcp` for `httpAdminRoot: '/admin'`).
- `--user-dir <folder>`: Node-RED's user folder (userDir). Default `~/.node-red`; also `NODE_RED_USER_DIR`. If you start Node-RED with `-u <folder>`, give the same folder here.
- `PS_BRIDGE_POLL_MS` (environment): while Node-RED cannot be reached, how often the bridge looks again for its tools, in milliseconds. Default 5000.

The key lives in `<userDir>/physical-sandbox/mcp-key`. The plugin creates it when Node-RED starts (readable by your user only; on Windows this file mode has no effect, so the folder's own permissions are what protect it), and the bridge reads it from there. The route answers only this computer, and only with that key.

Limits of "this computer only":

- Behind a reverse proxy or a tunnel on the same computer (nginx, Cloudflare Tunnel, ngrok and so on), every caller looks local to Node-RED, and only the key guards the route. Keep the key file private.
- Node-RED in Docker does not see the host's calls as loopback, so the MCP route refuses them: the bridge does not work with Node-RED in a container.

### What the agent can do

- **Look at the setup.** The status of the pane (sign-in, scene, editors and panes open, the pictures switch) and the robots available, with their joints and chains.
- **Work out poses.** Inverse kinematics for a chain of a robot (position only in this version): the joint angles that put a hand at a point, or the closest ones when it is out of reach.
- **Set the scene and play motion.** Place or remove robots, play state messages in the pane (a new attempt replaces the last one; loops can be stopped), and turn messages into a record for a `ps play` node.
- **Open and save records.** Open a PS.com record, and save the stream as a new record or as the next version of the open one (same rules as the pane).
- **Work on flows.** Read the flows in the open editor and propose a flow (see "No deploying" below). Reading the flows (`ps_flows_read`) sends them to the agent, and through it to its AI provider: function nodes' code, broker addresses and the values of environment variables that are not secret (credentials are never included).
- **Look at the pane.** Only while the switch below is on.

### The pictures switch

The pane's switch "Share frames with the agent" is **off by default** and is not kept across restarts: after Node-RED restarts, it is off again. While it is **on**, the agent can ask for pictures of the pane (`ps_pane_frames`), and those pictures include the background photo or video. They go to the agent, and through it to the AI provider the agent runs on. This is the one place where pictures leave your machine. They are never sent to PS.com. With the switch off, nothing is sent and the tool is refused.

### No deploying

The agent never deploys. `ps_flow_propose` makes the Node-RED editor import the nodes (in a new tab, with new ids, so nothing of yours is overwritten) as an undeployed change, and shows a notice. Nothing runs until you check it and press Deploy: your Deploy is the approval.

### Example

You ask Claude: 「OpenArm に盆踊りさせて」 (make OpenArm dance a bon odori). The agent places OpenArm, works out arm poses with the inverse kinematics tool (both hands above the head, and so on), and plays them in a loop. You see the robot dancing in the pane. Then it may offer a flow: it proposes `inject → ps play → mqtt out` in a new tab of the editor, waiting for your Deploy. Music is not part of this: sync it with another node. The background (the real site behind the robot) is chosen by you in the pane.

## Privacy and limits

- The background photo or video never leaves this computer, except while you turn on the pane's "Share frames with the agent" switch: then the pictures go to the connected agent and its AI provider (never to PS.com). Only the record (states and the scene's devices)
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
