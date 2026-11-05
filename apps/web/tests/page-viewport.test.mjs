import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageAtViewportY} from '../.tmp/tests/features/reader/pageViewport.js';

test('locates the reading page in a large document without scanning its pages', () => {
  let top = 10, reads = 0;
  const children = Array.from({length: 1024}, (_, index) => {
    const height = index % 3 === 0 ? 380 : 840;
    const bounds = {top, bottom: top + height, height};
    top = bounds.bottom + 24;
    return {dataset: {pageNumber: String(index + 1)}, getBoundingClientRect: () => {reads++; return bounds;}};
  });
  children.push({dataset: {}});
  const stage = {children};
  const target = children[800].getBoundingClientRect();
  reads = 0;
  assert.equal(pageAtViewportY(stage, target.top + 100).page, children[800]);
  assert.ok(reads <= 12, `read ${reads} page bounds`);
  assert.equal(pageAtViewportY(stage, target.bottom + 4), undefined);
  assert.equal(pageAtViewportY(stage, target.bottom + 4, true).page, children[800]);
  assert.equal(pageAtViewportY(stage, target.bottom + 20, true).page, children[801]);
  assert.equal(pageAtViewportY(stage, top + 200, true).page, children[1023]);
});
