import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SCALE, MIN_SCALE, fitView, keepView, placeKept, stepScale, zoomAt } from '../src/editor/viewMath.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('fitView shows a box whole and centered, with its margin', () => {
  const v = fitView({ width: 1000, height: 600 }, { x: 0, y: 0, width: 800, height: 600 }, 50);
  near(v.scale, 500 / 600);
  near(v.x + 400 * v.scale, 500); // the box's middle at the screen's middle
  near(v.y + 300 * v.scale, 300);
  const part = fitView({ width: 1000, height: 600 }, { x: 100, y: 100, width: 100, height: 50 }, 50);
  near(part.x + 150 * part.scale, 500);
  near(part.y + 125 * part.scale, 300);
});

test('fitView on a screen smaller than its margins still fits the box', () => {
  const v = fitView({ width: 60, height: 600 }, { x: 0, y: 0, width: 100, height: 100 }, 80);
  near(v.scale, 30 / 100); // a quarter of the width on each side
  near(v.x + 50 * v.scale, 30);
});

test('zoomAt keeps the point under the pointer still, within the limits', () => {
  const view = { x: 20, y: 30, scale: 1 };
  const at = { x: 220, y: 130 };
  const z = zoomAt(view, at, 4);
  near((at.x - z.x) / z.scale, (at.x - view.x) / view.scale);
  near((at.y - z.y) / z.scale, (at.y - view.y) / view.scale);
  assert.equal(zoomAt(view, at, 1000).scale, MAX_SCALE);
  assert.equal(zoomAt(view, at, 0).scale, MIN_SCALE);
});

test('stepScale goes to the next step either way, and stops at the ends', () => {
  assert.equal(stepScale(1, 1), 1.5);
  assert.equal(stepScale(1, -1), 0.75);
  assert.equal(stepScale(1.2, 1), 1.5);
  assert.equal(stepScale(1.2, -1), 1);
  assert.equal(stepScale(MAX_SCALE, 1), MAX_SCALE);
  assert.equal(stepScale(MIN_SCALE, -1), MIN_SCALE);
});

test('a kept view keeps the middle of the screen on another screen size', () => {
  const view = { x: -150, y: 40, scale: 2 };
  const kept = keepView(view, { width: 800, height: 600 });
  const back = placeKept(kept, { width: 1200, height: 900 });
  near(back.scale, 2);
  near((600 - back.x) / back.scale, kept.cx);
  near((450 - back.y) / back.scale, kept.cy);
});
