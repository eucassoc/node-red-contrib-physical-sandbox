import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as build from '../../src/pscom/robot-build.js';
import { armBundle, catalogFetch } from './helpers/robot-bundle.js';

test('buildRobot takes the mesh addresses and the fetch from its caller', async () => {
  const urls = [];
  const fetchImpl = catalogFetch();
  const robot = await build.buildRobot(armBundle(), {
    meshUrlOf: (relative) => `/api/catalog/physical-sandbox/arm/1/files/${relative}`,
    fetchImpl: (url) => { urls.push(url); return fetchImpl(url); },
  });
  assert.deepEqual(urls, ['/api/catalog/physical-sandbox/arm/1/files/meshes/part.bin']);
  robot.setJoint('shoulder', 5);
  assert.equal(robot.jointNodes.get('shoulder').value, 1, 'clamped to the upper limit');
});
