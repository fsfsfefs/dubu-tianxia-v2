import {test} from 'node:test';
import assert from 'node:assert/strict';
import {horizontalPanOrigin, touchMomentum} from '../.tmp/tests/features/reader/touchPan.js';

test('vertical panning ignores small drift and unlocks at a bounded lateral distance', () => {
  assert.equal(horizontalPanOrigin(12, 80), null);
  assert.equal(horizontalPanOrigin(-40, 200), null);
  assert.equal(horizontalPanOrigin(28, 0), 28);
  assert.equal(horizontalPanOrigin(-70, 200), -64);
});

test('large, fast vertical swipes coast faster without introducing sideways momentum', () => {
  assert.deepEqual(touchMomentum({x: .4, y: 1}, -60, false), {x: 0, y: 1, decayTime: 135});
  assert.deepEqual(touchMomentum({x: .4, y: .3}, -240, false), {x: 0, y: .3, decayTime: 135});
  const rapid = touchMomentum({x: .4, y: 2}, -240, false);
  assert.equal(rapid.x, 0);
  assert.ok(rapid.y > 3 && rapid.decayTime > 135);
  assert.deepEqual(touchMomentum({x: -1, y: 2}, -240, true), {x: -1, y: 2, decayTime: 135});
  assert.equal(touchMomentum({x: 0, y: -2}, -240, false).y, -2);
});
