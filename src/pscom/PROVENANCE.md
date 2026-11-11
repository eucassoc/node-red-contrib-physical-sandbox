# Where these files come from

Everything in this folder is copied from PS.com (`~/work/ps-com`, commit `615120e`) on 2026-11-11.
The owner of PS.com allowed the copy into this public repository under Apache-2.0 (2026-11-11).

Each file starts with a three-line header (source path, commit, licence note) and is otherwise
the same text as its source. Three exceptions, all marked:

- `catalog-client.js` has one seam, `setCatalogBase(base, fetchImpl?)`, so the pane can reach the
  catalog through a Node-RED route. Seam lines sit between `PSCOM-SEAM-BEGIN` / `PSCOM-SEAM-END`, or
  are a `PSCOM-SEAM-WAS <original line>` comment followed by the new line ending in `PSCOM-SEAM-NEW`.
- `fit-rect.js` is an excerpt: only `fitRect` (with its comment) from `app/src/video-rules.js`.
- `state.js` is `app/src/devices/state.js`.

| Here | PS.com (app/src/) |
| --- | --- |
| camera-model.js, pose-solve.js, floor-frame.js, roundtrip.js, i18n.js, record-upgrade.js, replay-rules.js, robot-build.js, catalog-client.js, orbit.js | the same name |
| state.js | devices/state.js |
| fit-rect.js | excerpt of video-rules.js |

`node tools/check-pscom-copy.mjs` compares each file with `~/work/ps-com` (when that folder exists)
and prints the differences. It is a developer tool and is not part of `npm test`.

The tests in `tests/pscom/` are PS.com's, with imports adjusted. Cases that need PS.com files outside
this set were left out: `camera-model` (floor-pose.js), `record-upgrade` (the stage test: view.js,
registry.js, drive-geometry.js, placing-rules.js), `robot-build` (the `loadRobot` cases of robot.js).
`state.test.js` uses a one-line stand-in for registry.js's `parseDevices`. `video-rules.test.js` is
not copied; its `fitRect` cases are in `fit-rect.test.js`.

When PS.com changes one of these files, copy it again by hand (header, seam) and update the commit.
