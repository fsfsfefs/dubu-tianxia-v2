import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eraseInk} from '../.tmp/tests/features/reader/eraseInk.js';

const rect = (x, y) => ({x, y, width:.004, height:.004});
const size = {width:595, height:842};

test('eraser cuts between sparse vertices without deleting untouched endpoints', () => {
  const original = [rect(.1,.5), rect(.9,.5)];
  const segments = eraseInk(original, [{x:.5,y:.5}], size);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0][0], original[0]);
  assert.deepEqual(segments[1].at(-1), original[1]);
  assert.ok(segments[0].at(-1).x < .49);
  assert.ok(segments[1][0].x > .51);
  assert.deepEqual(original, [rect(.1,.5), rect(.9,.5)]);
});

test('eraser sweeps the entire drag even when both input points miss the ink', () => {
  const segments = eraseInk([rect(.1,.5),rect(.9,.5)], [{x:.5,y:.2},{x:.5,y:.8}], size);
  assert.equal(segments.length, 2);
  assert.equal(eraseInk([rect(.1,.5),rect(.9,.5)], [{x:.5,y:.2}], size), null);
  assert.deepEqual(eraseInk([rect(.1,.5),rect(.9,.5)], [{x:0,y:.5},{x:1,y:.5}], size), []);
});

test('eraser follows the displayed quadratic curve instead of only its control points', () => {
  assert.equal(eraseInk([rect(.1,.1),rect(.5,.9),rect(.9,.1)], [{x:.45,y:.6}], size).length, 2);
});

test('eraser respects actual page aspect ratio and keeps untouched strokes unchanged', () => {
  const original = [rect(.5,.2),rect(.5,.8)];
  assert.equal(eraseInk(original, [{x:.506,y:.5}], {width:1000,height:500}), null);
  assert.equal(eraseInk(original, [{x:.506,y:.5}], {width:500,height:1000}).length, 2);
  assert.equal(eraseInk(original, [], size), null);
});

test('flattened long strokes are split within the persistence point limit', () => {
  const points = Array.from({length:1200}, (_,i) => rect(i/1200, .5 + Math.sin(i)*.02));
  const segments = eraseInk(points, [{x:.01,y:.5}], size);
  assert.ok(segments.length);
  assert.ok(segments.every(segment => segment.length >= 2 && segment.length <= 1200));
  assert.deepEqual(segments.at(-1).at(-1), points.at(-1));
});
