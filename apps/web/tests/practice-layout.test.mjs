import {test} from 'node:test';
import assert from 'node:assert/strict';
import {joinRegionLines} from '../.tmp/tests/features/reader/regionText.js';
import {formatCardQuestion} from '../.tmp/tests/features/practice/formatCardQuestion.js';

test('region text follows PDF line positions and preserves same-line choices', () => {
  const fragment = (text, left, right, top) => ({text, left, right, top, height: 14});
  assert.equal(joinRegionLines([
    fragment('B 3 项', 200, 231, 71),
    fragment('②第二项', 12, 71, 51),
    fragment('正确的是（ ）', 112, 193, 10),
    fragment('A 2 项', 12, 49, 70),
    fragment('9. 下列说法中', 12, 112, 10),
    fragment('①第一项', 12, 71, 31),
  ]), '9. 下列说法中正确的是（ ）\n①第一项\n②第二项\nA 2 项 B 3 项');
});

test('card display preserves existing lines and separates legacy question options', () => {
  const original = '9. 哪些选项正确？\n①第一项\n②第二项\nA 2项\nB 3项\nC 4项\nD 5项';
  assert.equal(formatCardQuestion(original), original);
  assert.equal(formatCardQuestion(original.replaceAll('\n', ' ')), original);
  assert.equal(formatCardQuestion('哪组顺序正确？ A. ①② B. ②① C. ①③ D. ③①'),
    '哪组顺序正确？\nA. ①②\nB. ②①\nC. ①③\nD. ③①');
});
