import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Path2D, flattenPath, matApply, matMultiply, matInvert } from '../lib/path.js';
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
      calls.push(['fillText', text, x, y, this.font, this.textAlign, this.fillStyle]);
    },
    clip(path) {
      calls.push(['clip', path, this._m.slice()]);
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

test('linearGradient paint resolves via url(#id) in user coordinates', () => {
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
  // objectBoundingBox 0..1 over a 10x10 shape, in the shape's own units:
  // the 10x viewBox scale is the context's transform to apply, not ours
  assert.deepEqual([gradient.x1, gradient.y1, gradient.x2, gradient.y2], [0, 0, 10, 0]);
  assert.equal(gradient.stops.length, 2);
  assert.equal(gradient.stops[1][1], 'rgba(0, 0, 255, 0.5)');
});

test('an element that is display: none is not drawn, nor anything in it', () => {
  // SVG 1.1, 11.5: `display` is not inherited, and nothing in an element
  // that is `none` is rendered, whatever it says of itself. Illustrator
  // exports a hidden layer as `<g display="none">` around shapes it marks
  // `display="inline"`, and every hidden layer of such a file was drawn
  // over the one that shows
  const view = new SvgView(null).setSvg(
    `<svg viewBox="0 0 10 10">
      <g><circle cx="5" cy="5" r="4" fill="#fff"/></g>
      <g display="none"><rect display="inline" width="10" height="10" fill="#c157a1"/></g>
      <g style="display: none"><rect width="10" height="10" fill="#00f"/></g>
      <rect display="none" width="10" height="10" fill="#0f0"/>
      <g display="inline"><rect width="2" height="2" fill="#f00"/></g>
    </svg>`
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 10, 10);
  assert.deepEqual(
    of(ctx.calls, 'fill').map((call) => call[3]),
    ['#fff', '#f00'],
    'the layers that show, and none of the hidden ones'
  );
  // and what is not drawn is none of the document's paints
  const icon = new SvgView(null).setSvg(
    `<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#333"/>
      <g display="none"><rect display="inline" width="10" height="10" fill="#c157a1"/></g></svg>`
  );
  assert.equal(icon.paintKind, 'mono');
  assert.equal(icon.soloPaint, '#333');
});

test('what display: none hides can still be referenced, and a use of it draws nothing', () => {
  // SVG 2, 5.3: a symbol, a gradient and what is in a hidden group are
  // still there for a use or a url() to name; an element that is itself
  // display: none is drawn as nothing through a use too
  const view = new SvgView(null).setSvg(
    `<svg viewBox="0 0 10 10">
      <defs style="display: none">
        <linearGradient id="g" display="none"><stop offset="0" stop-color="#f00"/></linearGradient>
      </defs>
      <symbol id="s" display="none"><rect width="1" height="1" fill="#100"/></symbol>
      <g display="none"><rect id="in" width="1" height="1" fill="#200"/></g>
      <rect id="off" display="none" width="1" height="1" fill="#300"/>
      <use href="#s"/>
      <use href="#in"/>
      <use href="#off"/>
      <rect width="1" height="1" fill="url(#g)"/>
    </svg>`
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 10, 10);
  const fills = of(ctx.calls, 'fill').map((call) => call[3]);
  assert.deepEqual(fills.slice(0, 2), ['#100', '#200']);
  assert.equal(fills.length, 3);
  assert.equal(fills[2].type, 'linear');
});

test('a shape whose visibility is hidden is not drawn, and one in a hidden group can show again', () => {
  // SVG 1.1, 11.5: `visibility` is inherited, unlike `display`, and hides
  // only what an element paints itself. A group that is hidden still holds
  // what says `visible`
  const view = new SvgView(null).setSvg(
    `<svg viewBox="0 0 10 10">
      <rect visibility="hidden" width="1" height="1" fill="#100"/>
      <rect style="visibility: collapse" width="1" height="1" fill="#200"/>
      <rect visibility="hidden" style="visibility: visible" width="1" height="1" fill="#300"/>
      <rect visibility="hidden" style="visibility: sideways" width="1" height="1" fill="#400"/>
      <g visibility="hidden">
        <rect width="1" height="1" fill="#500"/>
        <rect visibility="visible" width="1" height="1" fill="#600"/>
        <g><rect width="1" height="1" fill="#700"/></g>
        <text x="0" y="5">hidden</text>
      </g>
      <defs><rect id="plain" width="1" height="1"/></defs>
      <use href="#plain" visibility="hidden" fill="#800"/>
      <use href="#plain" fill="#900"/>
      <text x="0" y="5" style="visibility:hidden">hidden too</text>
      <text x="0" y="5">shown</text>
    </svg>`
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 10, 10);
  assert.deepEqual(
    of(ctx.calls, 'fill').map((call) => call[3]),
    ['#300', '#600', '#900'],
    'inline style over the attribute, a child that shows itself, a use that is not hidden'
  );
  assert.deepEqual(of(ctx.calls, 'fillText').map((call) => call[1]), ['shown']);

  // and a hidden shape paints none of the document's colours
  const icon = new SvgView(null).setSvg(
    `<svg viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10"/>
      <rect visibility="hidden" width="4" height="4" fill="#c157a1"/>
      <g style="visibility: hidden"><text fill="#00f">x</text><path d="M0 0h1v1z" stroke="#0f0"/></g></svg>`
  );
  assert.equal(icon.paintKind, 'mono');
  assert.equal(icon.soloPaint, 'currentColor');
  // what shows itself again in a hidden group is counted
  const shown = new SvgView(null).setSvg(
    `<svg viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10"/>
      <g visibility="hidden"><rect visibility="visible" width="4" height="4" fill="#c157a1"/></g></svg>`
  );
  assert.equal(shown.paintKind, 'multi');
});

test('opacity in an inline style is read, and wins over the attribute', () => {
  // as fill-opacity and stroke-opacity already were: `style="opacity:.2"`
  // drew an opaque shape
  const view = new SvgView(null).setSvg(
    `<svg viewBox="0 0 10 10">
      <rect style="opacity:.2" width="1" height="1"/>
      <rect opacity="0.9" style="opacity: 0.4" width="1" height="1"/>
      <rect opacity="50%" width="1" height="1"/>
      <rect opacity="0.6" style="opacity: bold" width="1" height="1"/>
      <rect opacity="3" width="1" height="1"/>
      <g style="opacity: .5"><rect width="1" height="1" style="opacity: .5; fill-opacity: 40%"/></g>
      <rect style="opacity: 0" width="1" height="1"/>
    </svg>`
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 10, 10);
  const alphas = of(ctx.calls, 'fill').map((call) => Math.round(call[4] * 1e6) / 1e6);
  // a percentage is of 1, a declaration it cannot read leaves the
  // attribute's, a value past 1 is 1, a group's multiplies down, and what
  // is transparent is not drawn at all
  assert.deepEqual(alphas, [0.2, 0.4, 0.5, 0.6, 1, 0.1]);
});

test('a nested <svg> is a viewport at its x and y, not a group', () => {
  // SVG 2, 8.2: the inner document's origin is its x,y, and what it draws
  // is clipped to its width by height
  const view = new SvgView(null).setSvg(
    `<svg width="40" height="40">
      <svg x="10" y="10" width="20" height="20"><rect width="20" height="20" fill="#cf222e"/></svg>
    </svg>`
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 40, 40);
  const [fill] = of(ctx.calls, 'fill');
  assert.deepEqual(matApply(fill[5], 0, 0), [10, 10]);
  assert.deepEqual(matApply(fill[5], 20, 20), [30, 30]);
  const [clip] = of(ctx.calls, 'clip');
  assert.ok(clip, 'the viewport is a clip');
  // the clip is the viewport, set in the space around it
  assert.deepEqual(matApply(clip[2], 0, 0), [0, 0]);
  assert.deepEqual(flattenPath(clip[1]._cmds)[0].pts, [10, 10, 30, 10, 30, 30, 10, 30]);
  // and nothing of it outlives it
  const saves = of(ctx.calls, 'save').length;
  assert.equal(of(ctx.calls, 'restore').length, saves);
});

test('a nested <svg> fits its viewBox as preserveAspectRatio says', () => {
  const at = (par) => {
    const view = new SvgView(null).setSvg(
      `<svg width="40" height="40"><svg x="4" y="8" width="32" height="24" viewBox="0 0 10 10"${
        par ? ` preserveAspectRatio="${par}"` : ''
      }><rect width="10" height="10"/></svg></svg>`
    );
    const ctx = mockCtx();
    view.draw(ctx, 0, 0, 40, 40);
    const m = of(ctx.calls, 'fill')[0][5];
    return [...matApply(m, 0, 0), ...matApply(m, 10, 10)].map((v) => Math.round(v * 1e6) / 1e6);
  };
  // xMidYMid meet: 24 square, centred across the 32
  assert.deepEqual(at(null), [8, 8, 32, 32]);
  assert.deepEqual(at('xMidYMid meet'), [8, 8, 32, 32]);
  assert.deepEqual(at('xMinYMax'), [4, 8, 28, 32]);
  assert.deepEqual(at('xMaxYMin meet'), [12, 8, 36, 32]);
  // slice: 32 square, over the 24 and clipped to it
  assert.deepEqual(at('xMinYMin slice'), [4, 8, 36, 40]);
  assert.deepEqual(at('xMidYMid slice'), [4, 4, 36, 36]);
  // none stretches it
  assert.deepEqual(at('none'), [4, 8, 36, 32]);
  // a value it cannot read is the default, all of it
  assert.deepEqual(at('xMidYMad slice'), [8, 8, 32, 32]);
});

test('a nested <svg> takes percentages of the viewport around it, and its viewBox origin', () => {
  const view = new SvgView(null).setSvg(
    `<svg viewBox="0 0 40 40">
      <svg x="25%" y="25%" width="50%" height="50%">
        <rect width="100%" height="100%" fill="#1a7f37"/>
        <svg x="50%" width="50%" height="50%"><rect width="4" height="4" fill="#cf222e"/></svg>
      </svg>
      <svg x="5" y="5" width="30" height="30" viewBox="10 10 20 20"><rect x="10" y="10" width="1" height="1" fill="#000"/></svg>
      <svg><rect width="1" height="1" fill="#fff"/></svg>
    </svg>`
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 80, 80);
  const [, inner, origin, full] = of(ctx.calls, 'fill');
  // the viewBox's user space is 40 across, drawn at 80: twice what it says
  assert.deepEqual(matApply(inner[5], 0, 0), [40, 20], 'half of the 20 it sits in, from 10,10');
  assert.deepEqual(matApply(origin[5], 10, 10), [10, 10], 'the viewBox origin goes to its x,y');
  assert.deepEqual(matApply(full[5], 0, 0), [0, 0], 'no x, y, width or height is all of it');
  assert.equal(of(ctx.calls, 'clip').length, 4);
});

test('a nested <svg> is not clipped where its overflow is visible, and draws nothing at size zero', () => {
  const view = new SvgView(null).setSvg(
    `<svg width="40" height="40">
      <svg x="10" y="10" width="20" height="20" overflow="visible"><rect width="1" height="1" fill="#100"/></svg>
      <svg x="10" y="10" width="20" height="20" style="overflow: auto"><rect width="1" height="1" fill="#200"/></svg>
      <svg width="0" height="20"><rect width="1" height="1" fill="#300"/></svg>
      <svg width="-5"><rect width="1" height="1" fill="#400"/></svg>
      <svg viewBox="0 0 0 10"><rect width="1" height="1" fill="#500"/></svg>
      <svg viewBox="0 0 -10 10" x="3"><rect width="1" height="1" fill="#600"/></svg>
    </svg>`
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 40, 40);
  const fills = of(ctx.calls, 'fill');
  assert.deepEqual(fills.map((call) => call[3]), ['#100', '#200', '#600']);
  assert.equal(of(ctx.calls, 'clip').length, 1, 'only the one whose overflow is not visible');
  // a negative viewBox is an error, and is ignored rather than the element
  assert.deepEqual(matApply(fills[2][5], 0, 0), [3, 0]);
});

test('a gradient takes what it does not set, and its stops, from the one its href names', () => {
  // SVG 1.1, 13.2.2: an editor writes the stops once and points every
  // gradient that uses them at it. Read without the reference each had no
  // stops, and what it filled was not drawn
  const view = new SvgView(null);
  view.setSvg(`<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 10">
    <defs>
      <linearGradient id="stops" gradientUnits="userSpaceOnUse" x2="7">
        <stop offset="0" stop-color="#ff0000"/>
        <stop offset="1" stop-color="#0000ff"/>
      </linearGradient>
      <linearGradient id="line" xlink:href="#stops" x1="2" y1="3"/>
      <linearGradient id="twice" href="#line" y2="9"/>
      <radialGradient id="round" href="#twice" cx="4" cy="5" r="6"/>
      <linearGradient id="own" href="#stops"><stop offset="0.5" stop-color="#00ff00"/></linearGradient>
      <linearGradient id="self" href="#loop"/><linearGradient id="loop" href="#self"/>
    </defs>
    <rect width="10" height="10" fill="url(#line)"/>
    <rect width="10" height="10" fill="url(#twice)"/>
    <rect width="10" height="10" fill="url(#round)"/>
    <rect width="10" height="10" fill="url(#own)"/>
    <rect width="10" height="10" fill="url(#loop)"/>
  </svg>`);
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 20, 10);
  const [line, twice, round, own, loop] = of(ctx.calls, 'fill').map((fill) => fill[3]);
  const colors = (g) => g.stops.map((stop) => stop[1]);
  // its own x1 and y1, the other's units and x2, and the other's stops
  assert.deepEqual([line.x1, line.y1, line.x2, line.y2], [2, 3, 7, 0]);
  assert.deepEqual(colors(line), ['#ff0000', '#0000ff']);
  // through a gradient that itself takes after one
  assert.deepEqual([twice.x1, twice.y1, twice.x2, twice.y2], [2, 3, 7, 9]);
  assert.deepEqual(colors(twice), ['#ff0000', '#0000ff']);
  // a radial one takes a linear one's stops and units, and none of its line
  assert.equal(round.type, 'radial');
  assert.deepEqual([round.x1, round.y1, round.r1], [4, 5, 6]);
  assert.deepEqual(colors(round), ['#ff0000', '#0000ff']);
  // stops of its own are the ones it has
  assert.deepEqual(colors(own), ['#00ff00']);
  // and two that name each other are read once each
  assert.deepEqual(colors(loop), []);
});

test('a gradient is set through its gradientTransform', () => {
  const view = new SvgView(null);
  const gradient = (attrs) =>
    `<linearGradient ${attrs}><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>`;
  view.setSvg(`<svg viewBox="0 0 10 10">
    <defs>
      ${gradient('id="moved" gradientUnits="userSpaceOnUse" x2="10" gradientTransform="translate(5, 1)"')}
      ${gradient('id="stretched" gradientUnits="userSpaceOnUse" x2="10" y2="10" gradientTransform="scale(2, 1)"')}
      ${gradient('id="turned" gradientTransform="rotate(90)"')}
      <radialGradient id="round" gradientUnits="userSpaceOnUse" cx="5" cy="5" r="5"
        gradientTransform="translate(1, 2) scale(2)"><stop offset="0" stop-color="#f00"/></radialGradient>
    </defs>
    <rect width="10" height="10" fill="url(#moved)"/>
    <rect width="10" height="10" fill="url(#stretched)"/>
    <rect x="10" y="20" width="10" height="40" fill="url(#turned)"/>
    <rect width="10" height="10" fill="url(#round)"/>
  </svg>`);
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 10, 10);
  const [moved, stretched, turned, round] = of(ctx.calls, 'fill').map((fill) => fill[3]);
  const line = (g) => [g.x1, g.y1, g.x2, g.y2].map((v) => Math.round(v * 1e6) / 1e6);
  assert.deepEqual(line(moved), [5, 1, 15, 1]);
  // stretched across, its lines of one colour lean, and the gradient's
  // line is the one square to them: not where the matrix takes its end,
  // (20, 10), which would run the colours along a line they do not cross
  assert.deepEqual(line(stretched), [0, 0, 8, 16]);
  // in the box's own space where that is its units: a quarter turn about
  // the box's corner, across a box four times as tall as it is wide
  assert.deepEqual(line(turned), [10, 20, 10, 60]);
  // a circle's centre goes with the matrix, and its radius with its scale
  assert.deepEqual([round.x1, round.y1, round.r1], [11, 12, 10]);
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

// --- external currentColor, and the mono/multi paint scan ------------------

const ICON = (paint) =>
  `<svg viewBox="0 0 24 24"><g fill="none" stroke="${paint}" stroke-width="2">` +
  '<circle cx="12" cy="12" r="9"/><line x1="6" y1="12" x2="18" y2="12"/></g></svg>';

test('currentColor resolves to the colour the caller draws with', () => {
  const view = new SvgView(null).setSvg(ICON('currentColor'));
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 24, 24, { color: '#e17055' });
  assert.equal(of(ctx.calls, 'stroke')[0][2], '#e17055');
});

test('currentColor falls back to the view colour, then to black', () => {
  const ctx = mockCtx();
  new SvgView(null, { color: '#0984e3' })
    .setSvg(ICON('currentColor'))
    .draw(ctx, 0, 0, 24, 24);
  assert.equal(of(ctx.calls, 'stroke')[0][2], '#0984e3');

  const plain = mockCtx();
  new SvgView(null).setSvg(ICON('currentColor')).draw(plain, 0, 0, 24, 24);
  assert.equal(of(plain.calls, 'stroke')[0][2], '#000');
});

test('a per-draw colour overrides the view colour, and does not stick', () => {
  const view = new SvgView(null, { color: '#0984e3' }).setSvg(ICON('currentColor'));
  const once = mockCtx();
  view.draw(once, 0, 0, 24, 24, { color: '#d63031' });
  assert.equal(of(once.calls, 'stroke')[0][2], '#d63031');
  // the same parsed document, drawn again with no options
  const after = mockCtx();
  view.draw(after, 0, 0, 24, 24);
  assert.equal(of(after.calls, 'stroke')[0][2], '#0984e3');
});

test('currentColor reaches text too', () => {
  const view = new SvgView(null).setSvg(
    '<svg viewBox="0 0 100 100"><text x="0" y="10" fill="currentColor">hi</text></svg>'
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 100, 100, { color: '#00b894' });
  assert.equal(of(ctx.calls, 'fillText')[0][6], '#00b894');
});

test('paint scan: one paint is mono, whatever that paint is', () => {
  const literal = new SvgView(null).setSvg(ICON('#2d3436'));
  assert.equal(literal.paintKind, 'mono');
  assert.equal(literal.soloPaint, '#2d3436');

  const deferred = new SvgView(null).setSvg(ICON('currentColor'));
  assert.equal(deferred.paintKind, 'mono');
  assert.equal(deferred.soloPaint, 'currentColor');

  // nothing specified anywhere: shapes take the initial fill, black
  const bare = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
  );
  assert.equal(bare.paintKind, 'mono');
  assert.equal(bare.soloPaint, '#000');
});

test('paint scan: a second distinct paint is multi', () => {
  const two = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="#f00"/>' +
      '<rect x="5" width="4" height="4" fill="#0f0"/></svg>'
  );
  assert.equal(two.paintKind, 'multi');

  // a literal alongside currentColor is two colours, not one
  const mixed = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="currentColor"/>' +
      '<rect x="5" width="4" height="4" fill="#0f0"/></svg>'
  );
  assert.equal(mixed.paintKind, 'multi');
});

test('paint scan: a gradient or pattern reference is multi', () => {
  const grad = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>'
  );
  assert.equal(grad.paintKind, 'multi');
});

test('paint scan: opacity does not make a document multi-coloured', () => {
  const faded = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10"><g opacity="0.5" fill="currentColor">' +
      '<rect width="4" height="4" fill-opacity="0.3"/>' +
      '<rect x="5" width="4" height="4"/></g></svg>'
  );
  assert.equal(faded.paintKind, 'mono');
  assert.equal(faded.soloPaint, 'currentColor');
});

test('paint scan: none never counts, and a <line> contributes no fill', () => {
  // fill is inherited black here, but a <line> is stroke-only — counting its
  // fill would call this two-coloured and cost the cache a mask entry
  const line = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="#333"/></svg>'
  );
  assert.equal(line.paintKind, 'mono');
  assert.equal(line.soloPaint, '#333');
});

test('paint scan: inline style beats the presentation attribute', () => {
  const styled = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#f00" style="fill: #0f0"/></svg>'
  );
  assert.equal(styled.paintKind, 'mono');
  assert.equal(styled.soloPaint, '#0f0');
});

test('paint scan: <use> paints its target with the use element style', () => {
  const used = new SvgView(null).setSvg(
    '<svg viewBox="0 0 20 10"><defs><circle id="c" cx="5" cy="5" r="4"/></defs>' +
      '<use href="#c" fill="currentColor"/><use href="#c" x="10" fill="currentColor"/></svg>'
  );
  assert.equal(used.paintKind, 'mono');
  assert.equal(used.soloPaint, 'currentColor');
});

test('paint scan: defs that nothing references contribute nothing', () => {
  // the gradient is declared but never used — the drawing is still one colour
  const unused = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="currentColor"/></svg>'
  );
  assert.equal(unused.paintKind, 'mono');
  assert.equal(unused.soloPaint, 'currentColor');
});

test('paint scan: re-adopting a document re-scans it', () => {
  const view = new SvgView(null).setSvg(ICON('currentColor'));
  assert.equal(view.soloPaint, 'currentColor');
  view.setSvg('<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="#f00"/>' +
    '<rect x="5" width="4" height="4" fill="#0f0"/></svg>');
  assert.equal(view.paintKind, 'multi');
  assert.equal(view.soloPaint, null);
});

// --- presentation attributes on the root <svg> (issue #306) ----------------

// how lucide, feather, heroicons, tabler and Material Symbols all ship:
// the paint lives on the root, and the shapes name nothing at all
const LUCIDE_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

test('root <svg> paint reaches the shapes: an outline icon strokes, not fills', () => {
  const view = new SvgView(null).setSvg(LUCIDE_X);
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 24, 24, { color: '#c8d3e0' });

  // fill="none" on the root must reach both paths, or a closed outline icon
  // renders as a black silhouette
  assert.equal(of(ctx.calls, 'fill').length, 0);
  const strokes = of(ctx.calls, 'stroke');
  assert.equal(strokes.length, 2);
  for (const s of strokes) {
    assert.equal(s[2], '#c8d3e0'); // stroke="currentColor" from the root
    assert.equal(s[3], 2); // stroke-width="2" from the root
  }
});

test('root <svg> presentation attributes still lose to a child that names its own', () => {
  const view = new SvgView(null).setSvg(
    '<svg viewBox="0 0 20 10" fill="#f00" stroke-width="4">' +
      '<rect width="4" height="4"/>' +
      '<rect x="10" width="4" height="4" fill="#0f0" stroke="#00f"/></svg>'
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 20, 10);
  const fills = of(ctx.calls, 'fill');
  assert.equal(fills[0][3], '#f00'); // inherited from the root
  assert.equal(fills[1][3], '#0f0'); // own attribute wins
  assert.equal(of(ctx.calls, 'stroke')[0][3], 4); // root stroke-width inherits
});

test('inline style="" on the root applies like it does anywhere else', () => {
  const view = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10" fill="#f00" style="fill: #0f0">' +
      '<rect width="10" height="10"/></svg>'
  );
  const ctx = mockCtx();
  view.draw(ctx, 0, 0, 10, 10);
  assert.equal(of(ctx.calls, 'fill')[0][3], '#0f0');
});

test('paint scan agrees with what the root actually paints', () => {
  const icon = new SvgView(null).setSvg(LUCIDE_X);
  assert.equal(icon.paintKind, 'mono');
  assert.equal(icon.soloPaint, 'currentColor');

  const red = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10" fill="red"><rect width="10" height="10"/></svg>'
  );
  assert.equal(red.paintKind, 'mono');
  assert.equal(red.soloPaint, 'red');

  // a child overriding the root's paint is still two distinct colours
  const both = new SvgView(null).setSvg(
    '<svg viewBox="0 0 20 10" fill="red"><rect width="4" height="4"/>' +
      '<rect x="10" width="4" height="4" fill="blue"/></svg>'
  );
  assert.equal(both.paintKind, 'multi');
  assert.equal(both.soloPaint, null);

  // fill="none" on the root leaves only the stroke to count
  const strokeOnly = new SvgView(null).setSvg(
    '<svg viewBox="0 0 10 10" fill="none" stroke="#333"><rect width="10" height="10"/></svg>'
  );
  assert.equal(strokeOnly.paintKind, 'mono');
  assert.equal(strokeOnly.soloPaint, '#333');
});
