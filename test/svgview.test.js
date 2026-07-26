import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Path2D, matApply, matMultiply, matInvert } from '../lib/path.js';
import SvgView, { parseSvgTransform } from '../lib/widgets/svgview.js';

// A recording 2d-context stand-in with a working transform stack, so the
// widget can be exercised without an X server.
function mockCtx() {
  const calls = [];
  const ctx = {
    calls,
    _m: [1, 0, 0, 1, 0, 0],
    _stack: [],
    fillStyle: null,
    strokeStyle: null,
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    font: '',
    textAlign: 'start',
    save() {
      this._stack.push({ m: this._m.slice(), fillStyle: this.fillStyle, globalAlpha: this.globalAlpha });
      calls.push(['save']);
    },
    restore() {
      const s = this._stack.pop();
      if (s) {
        this._m = s.m;
        this.fillStyle = s.fillStyle;
        this.globalAlpha = s.globalAlpha;
      }
      calls.push(['restore']);
    },
    translate(x, y) {
      this._m = matMultiply(this._m, [1, 0, 0, 1, x, y]);
    },
    scale(x, y = x) {
      this._m = matMultiply(this._m, [x, 0, 0, y, 0, 0]);
    },
    transform(a, b, c, d, e, f) {
      this._m = matMultiply(this._m, [a, b, c, d, e, f]);
    },
    getTransform() {
      const [a, b, c, d, e, f] = this._m;
      return { a, b, c, d, e, f };
    },
    fillRect(x, y, w, h) {
      calls.push(['fillRect', x, y, w, h, this.fillStyle]);
    },
    fill(path, rule) {
      calls.push(['fill', path, rule, this.fillStyle, this.globalAlpha, this._m.slice()]);
    },
    stroke(path) {
      calls.push(['stroke', path, this.strokeStyle, this.lineWidth, this.globalAlpha]);
    },
    fillText(text, x, y) {
      calls.push(['fillText', text, x, y, this.font, this.textAlign]);
    },
    createLinearGradient(x1, y1, x2, y2) {
      const g = { type: 'linear', x1, y1, x2, y2, stops: [], addColorStop(o, c) { this.stops.push([o, c]); return this; } };
      calls.push(['createLinearGradient', x1, y1, x2, y2]);
      return g;
    },
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      const g = { type: 'radial', x0, y0, r0, x1, y1, r1, stops: [], addColorStop(o, c) { this.stops.push([o, c]); return this; } };
      calls.push(['createRadialGradient', x0, y0, r0, x1, y1, r1]);
      return g;
    }
  };
  return ctx;
}

const of = (calls, name) => calls.filter((c) => c[0] === name);

test('parseSvgTransform: translate/scale/rotate/matrix compose', () => {
  const ms = parseSvgTransform('translate(10, 20) scale(2) matrix(1 0 0 1 5 5)');
  assert.equal(ms.length, 3);
  let m = [1, 0, 0, 1, 0, 0];
  for (const t of ms) m = matMultiply(m, t);
  assert.deepEqual(matApply(m, 0, 0), [20, 30]);

  const rot = parseSvgTransform('rotate(90 10 10)');
  let r = [1, 0, 0, 1, 0, 0];
  for (const t of rot) r = matMultiply(r, t);
  const [x, y] = matApply(r, 20, 10);
  assert.ok(Math.abs(x - 10) < 1e-9 && Math.abs(y - 20) < 1e-9);
});

test('setSvg reads viewBox and width/height for the natural size', () => {
  const view = new SvgView(null);
  view.setSvg('<svg width="64" height="32" viewBox="0 0 128 64"></svg>');
  assert.equal(view.naturalWidth, 64);
  assert.equal(view.naturalHeight, 32);
  assert.deepEqual(view.viewBox, [0, 0, 128, 64]);

  const vbOnly = new SvgView(null).setSvg('<svg viewBox="0 0 24 24"/>');
  assert.equal(vbOnly.naturalWidth, 24);
});

test('rect/circle/path elements fill with inherited styles', () => {
  const view = new SvgView(null);
  view.setSvg(`<svg viewBox="0 0 100 100">
    <g fill="#ff0000">
      <rect x="10" y="10" width="30" height="30"/>
      <circle cx="70" cy="70" r="10" fill="#00ff00"/>
    </g>
    <path d="M0 0 H10 V10 Z" fill="none" stroke="blue" stroke-width="3"/>
  </svg>`);
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 100, 100);

  const fills = of(ctx.calls, 'fill');
  assert.equal(fills.length, 2);
  assert.equal(fills[0][3], '#ff0000'); // inherited from <g>
  assert.equal(fills[1][3], '#00ff00'); // own attribute wins
  assert.ok(fills[0][1] instanceof Path2D);

  const strokes = of(ctx.calls, 'stroke');
  assert.equal(strokes.length, 1);
  assert.equal(strokes[0][2], 'blue');
  assert.equal(strokes[0][3], 3);
});

test('viewBox scaling reaches the context transform', () => {
  const view = new SvgView(null);
  view.setSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 100, 100);
  const fill = of(ctx.calls, 'fill')[0];
  const m = fill[5];
  assert.deepEqual(matApply(m, 10, 10), [100, 100]); // 10x scale
});

test('group transform and opacity apply to children', () => {
  const view = new SvgView(null);
  view.setSvg(`<svg viewBox="0 0 100 100">
    <g transform="translate(50 0)" opacity="0.5">
      <rect width="10" height="10" fill-opacity="0.5" fill="black"/>
    </g>
  </svg>`);
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 100, 100);
  const fill = of(ctx.calls, 'fill')[0];
  assert.equal(fill[4], 0.25); // 0.5 group * 0.5 fill-opacity
  assert.deepEqual(matApply(fill[5], 0, 0), [50, 0]);
});

test('fill-rule=evenodd is forwarded', () => {
  const view = new SvgView(null);
  view.setSvg('<svg viewBox="0 0 10 10"><path d="M0 0h10v10h-10z M2 2h6v6h-6z" fill-rule="evenodd"/></svg>');
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 10, 10);
  assert.equal(of(ctx.calls, 'fill')[0][2], 'evenodd');
});

test('linearGradient paint resolves via url(#id) with device coordinates', () => {
  const view = new SvgView(null);
  view.setSvg(`<svg viewBox="0 0 10 10">
    <defs>
      <linearGradient id="g">
        <stop offset="0%" stop-color="#ff0000"/>
        <stop offset="100%" stop-color="#0000ff" stop-opacity="0.5"/>
      </linearGradient>
    </defs>
    <rect width="10" height="10" fill="url(#g)"/>
  </svg>`);
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 100, 100);
  const fill = of(ctx.calls, 'fill')[0];
  const gradient = fill[3];
  assert.equal(gradient.type, 'linear');
  // objectBoundingBox 0..1 over a 10x10 shape, scaled 10x to device
  assert.deepEqual([gradient.x1, gradient.y1, gradient.x2, gradient.y2], [0, 0, 100, 0]);
  assert.equal(gradient.stops.length, 2);
  assert.equal(gradient.stops[1][1], 'rgba(0, 0, 255, 0.5)');
});

test('use references defs content with x/y offset', () => {
  const view = new SvgView(null);
  view.setSvg(`<svg viewBox="0 0 100 100">
    <defs><rect id="unit" width="10" height="10"/></defs>
    <use href="#unit" x="30" y="40"/>
  </svg>`);
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 100, 100);
  const fill = of(ctx.calls, 'fill')[0];
  assert.deepEqual(matApply(fill[5], 0, 0), [30, 40]);
});

test('unsupported/non-rendered elements are skipped without errors', () => {
  const view = new SvgView(null);
  view.setSvg(`<svg viewBox="0 0 10 10">
    <title>hi</title><desc>x</desc>
    <filter id="f"/><mask id="m"/><clipPath id="c"/>
    <rect width="5" height="5"/>
  </svg>`);
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 10, 10);
  assert.equal(of(ctx.calls, 'fill').length, 1);
});

test('text renders through fillText with anchor mapping', () => {
  const view = new SvgView(null);
  view.setSvg('<svg viewBox="0 0 100 100"><text x="50" y="50" font-size="10" text-anchor="middle" fill="black">hi</text></svg>');
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 100, 100);
  const t = of(ctx.calls, 'fillText')[0];
  assert.equal(t[1], 'hi');
  assert.equal(t[5], 'center');
  assert.equal(t[4], '10px sans-serif'); // 10 * scale(1) at 100/100
});

test('nested svg documents inside html-ish wrappers still parse', () => {
  const view = new SvgView(null);
  view.setSvg('<?xml version="1.0"?><!-- c --><svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
  assert.equal(view.naturalWidth, 4);
});
