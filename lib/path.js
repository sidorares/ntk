// Vector path support shared by the 2d context and the SVG/TeX widgets:
//
// - affine matrix helpers ([a, b, c, d, e, f], canvas convention:
//   x' = a*x + c*y + e, y' = b*x + d*y + f)
// - an SVG path-data parser (full grammar incl. elliptical arcs, which are
//   converted to cubics) producing normalized M/L/C/Q/Z commands
// - Path2D: the HTML canvas retained-path class
// - flattenPath(): commands -> polylines, with adaptive (error-bounded)
//   bezier subdivision in device space

const TAU = Math.PI * 2;

// --------------------------------------------------------------------------
// matrices

export const MAT_IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** m · n (n applied first, then m — canvas ctx.transform() order) */
export function matMultiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

export function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function matInvert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function matIsIdentity(m) {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

// --------------------------------------------------------------------------
// elliptical arcs -> cubics

/**
 * Cubic bezier segments approximating an elliptical arc: center (cx, cy),
 * radii (rx, ry), rotated by phi, from angle a0 sweeping by da (signed,
 * |da| <= 2π). Returns { start: {x, y}, cmds: [{type:'C', ...}, ...] };
 * segments are split to <= 90° so the approximation error stays tiny.
 */
export function ellipseCubics(cx, cy, rx, ry, phi, a0, da) {
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const point = (a) => {
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    return [cx + cosPhi * x - sinPhi * y, cy + sinPhi * x + cosPhi * y];
  };
  const derivative = (a) => {
    const x = -rx * Math.sin(a);
    const y = ry * Math.cos(a);
    return [cosPhi * x - sinPhi * y, sinPhi * x + cosPhi * y];
  };

  const [sx, sy] = point(a0);
  const cmds = [];
  const n = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 2)));
  let a = a0;
  const step = da / n;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const k = (4 / 3) * Math.tan((b - a) / 4);
    const [x0, y0] = point(a);
    const [x3, y3] = point(b);
    const [dx0, dy0] = derivative(a);
    const [dx3, dy3] = derivative(b);
    cmds.push({
      type: 'C',
      x1: x0 + k * dx0,
      y1: y0 + k * dy0,
      x2: x3 - k * dx3,
      y2: y3 - k * dy3,
      x: x3,
      y: y3
    });
    a = b;
  }
  return { start: { x: sx, y: sy }, cmds };
}

/**
 * Canvas arc/ellipse semantics (start/end angle + counterclockwise flag,
 * with the spec's sweep normalization) -> { start, cmds } cubics.
 */
export function ellipseSegments(x, y, rx, ry, rotation, a0, a1, counterclockwise = false) {
  let da = a1 - a0;
  if (!counterclockwise) {
    if (da >= TAU) da = TAU;
    else {
      da %= TAU;
      if (da < 0) da += TAU;
    }
  } else if (-da >= TAU) {
    da = -TAU;
  } else {
    da %= TAU;
    if (da > 0) da -= TAU;
  }
  return ellipseCubics(x, y, rx, ry, rotation, a0, da);
}

// SVG endpoint parameterization (spec appendix F.6.5) -> center form -> cubics
function svgArcCommands(x0, y0, rx, ry, xRotationDeg, largeArc, sweep, x, y) {
  if (x0 === x && y0 === y) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return [{ type: 'L', x, y }];

  const phi = (xRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const angle = (ux, uy, vx, vy) => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const d = (ux * vx + uy * vy) / Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    return sign * Math.acos(Math.min(1, Math.max(-1, d)));
  };
  const a0 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let da = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && da > 0) da -= TAU;
  if (sweep && da < 0) da += TAU;

  const { cmds } = ellipseCubics(cx, cy, rx, ry, phi, a0, da);
  if (cmds.length) {
    // land exactly on the endpoint (kill accumulated fp error)
    cmds[cmds.length - 1].x = x;
    cmds[cmds.length - 1].y = y;
  }
  return cmds;
}

// --------------------------------------------------------------------------
// SVG path data

const CMD_ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * Parse SVG path data (`d` attribute) into normalized commands:
 * `{type:'M',x,y}`, `{type:'L',x,y}`, `{type:'C',x1,y1,x2,y2,x,y}`,
 * `{type:'Q',x1,y1,x,y}`, `{type:'Z'}`. H/V/S/T/A and all relative forms
 * are resolved; elliptical arcs are converted to cubics.
 *
 * The scanner is position-based (not a global number regex) so compact
 * arc flags like `a1 1 0 011 0` parse correctly.
 */
export function parseSvgPath(d) {
  const cmds = [];
  let i = 0;
  const n = d.length;

  const isWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  const skipSep = () => {
    while (i < n && (isWs(d[i]) || d[i] === ',')) i++;
  };
  const readNumber = () => {
    skipSep();
    const start = i;
    if (d[i] === '+' || d[i] === '-') i++;
    while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    if (d[i] === '.') {
      i++;
      while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    }
    if (d[i] === 'e' || d[i] === 'E') {
      i++;
      if (d[i] === '+' || d[i] === '-') i++;
      while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    }
    if (i === start) return null;
    const v = parseFloat(d.slice(start, i));
    return Number.isFinite(v) ? v : null;
  };
  const readFlag = () => {
    skipSep();
    if (d[i] === '0' || d[i] === '1') return d[i++] === '1';
    return null;
  };

  let cmd = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let px = null; // previous cubic/quad control point, for S/T reflection
  let py = null;

  while (i < n) {
    skipSep();
    if (i >= n) break;
    const ch = d[i];
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toUpperCase() in CMD_ARGC)) break; // invalid command: stop
      cmd = ch;
      i++;
    } else if (cmd === null) {
      break; // leading garbage
    }
    const rel = cmd >= 'a';
    const C = cmd.toUpperCase();

    if (C === 'Z') {
      cmds.push({ type: 'Z' });
      x = sx;
      y = sy;
      px = py = null;
      continue;
    }

    // one argument group; number-led repeats loop back via the while
    const before = i;
    let curved = false;
    switch (C) {
      case 'M': {
        const ax = readNumber();
        const ay = readNumber();
        if (ax === null || ay === null) return cmds;
        x = rel ? x + ax : ax;
        y = rel ? y + ay : ay;
        sx = x;
        sy = y;
        cmds.push({ type: 'M', x, y });
        cmd = rel ? 'l' : 'L'; // subsequent pairs are linetos
        break;
      }
      case 'L': {
        const ax = readNumber();
        const ay = readNumber();
        if (ax === null || ay === null) return cmds;
        x = rel ? x + ax : ax;
        y = rel ? y + ay : ay;
        cmds.push({ type: 'L', x, y });
        break;
      }
      case 'H': {
        const ax = readNumber();
        if (ax === null) return cmds;
        x = rel ? x + ax : ax;
        cmds.push({ type: 'L', x, y });
        break;
      }
      case 'V': {
        const ay = readNumber();
        if (ay === null) return cmds;
        y = rel ? y + ay : ay;
        cmds.push({ type: 'L', x, y });
        break;
      }
      case 'C':
      case 'S': {
        let x1;
        let y1;
        if (C === 'C') {
          const a = readNumber();
          const b = readNumber();
          if (a === null || b === null) return cmds;
          x1 = rel ? x + a : a;
          y1 = rel ? y + b : b;
        } else {
          x1 = px !== null ? 2 * x - px : x;
          y1 = py !== null ? 2 * y - py : y;
        }
        const c = readNumber();
        const dnum = readNumber();
        const e = readNumber();
        const f = readNumber();
        if (c === null || dnum === null || e === null || f === null) return cmds;
        const x2 = rel ? x + c : c;
        const y2 = rel ? y + dnum : dnum;
        x = rel ? x + e : e;
        y = rel ? y + f : f;
        cmds.push({ type: 'C', x1, y1, x2, y2, x, y });
        px = x2;
        py = y2;
        curved = true;
        break;
      }
      case 'Q':
      case 'T': {
        let x1;
        let y1;
        if (C === 'Q') {
          const a = readNumber();
          const b = readNumber();
          if (a === null || b === null) return cmds;
          x1 = rel ? x + a : a;
          y1 = rel ? y + b : b;
        } else {
          x1 = px !== null ? 2 * x - px : x;
          y1 = py !== null ? 2 * y - py : y;
        }
        const e = readNumber();
        const f = readNumber();
        if (e === null || f === null) return cmds;
        x = rel ? x + e : e;
        y = rel ? y + f : f;
        cmds.push({ type: 'Q', x1, y1, x, y });
        px = x1;
        py = y1;
        curved = true;
        break;
      }
      case 'A': {
        const rx = readNumber();
        const ry = readNumber();
        const rot = readNumber();
        const large = readFlag();
        const sweep = readFlag();
        const e = readNumber();
        const f = readNumber();
        if (rx === null || ry === null || rot === null || large === null || sweep === null || e === null || f === null) {
          return cmds;
        }
        const nx = rel ? x + e : e;
        const ny = rel ? y + f : f;
        for (const c of svgArcCommands(x, y, rx, ry, rot, large, sweep, nx, ny)) cmds.push(c);
        x = nx;
        y = ny;
        break;
      }
    }
    if (!curved) px = py = null;
    if (i === before) break; // no progress: malformed input
  }
  return cmds;
}

// --------------------------------------------------------------------------
// Path2D

function normalizeRadii(w, h, radii) {
  if (radii === undefined) radii = 0;
  if (typeof radii === 'number') radii = [radii];
  const take = (v) => (typeof v === 'number' ? { x: v, y: v } : { x: v.x ?? 0, y: v.y ?? 0 });
  let tl;
  let tr;
  let br;
  let bl;
  if (radii.length === 1) tl = tr = br = bl = take(radii[0]);
  else if (radii.length === 2) {
    tl = br = take(radii[0]);
    tr = bl = take(radii[1]);
  } else if (radii.length === 3) {
    tl = take(radii[0]);
    tr = bl = take(radii[1]);
    br = take(radii[2]);
  } else {
    tl = take(radii[0]);
    tr = take(radii[1]);
    br = take(radii[2]);
    bl = take(radii[3]);
  }
  // scale down so opposite corners never overlap
  const s = Math.min(
    1,
    w / (tl.x + tr.x) || 1,
    h / (tr.y + br.y) || 1,
    w / (br.x + bl.x) || 1,
    h / (bl.y + tl.y) || 1
  );
  const f = (r) => ({ x: Math.max(0, r.x * s), y: Math.max(0, r.y * s) });
  return [f(tl), f(tr), f(br), f(bl)];
}

/**
 * Retained path, HTML canvas compatible. Coordinates are in the space the
 * path is built in; the 2d context applies its current transform when the
 * path is filled/stroked/clipped (per the canvas spec).
 *
 *   new Path2D()                 empty
 *   new Path2D(otherPath)        copy
 *   new Path2D('M0 0L10 0...')   from SVG path data
 */
export class Path2D {
  constructor(init) {
    /** normalized commands (M/L/C/Q/Z); treat as read-only */
    this._cmds = [];
    this._x = null; // current point
    this._y = null;
    this._sx = null; // subpath start
    this._sy = null;
    if (init instanceof Path2D) {
      this._cmds = init._cmds.map((c) => ({ ...c }));
      this._x = init._x;
      this._y = init._y;
      this._sx = init._sx;
      this._sy = init._sy;
    } else if (typeof init === 'string') {
      this._append(parseSvgPath(init));
    }
  }

  _track(c) {
    if (c.type === 'M') {
      this._sx = c.x;
      this._sy = c.y;
      this._x = c.x;
      this._y = c.y;
    } else if (c.type === 'Z') {
      this._x = this._sx;
      this._y = this._sy;
    } else {
      this._x = c.x;
      this._y = c.y;
    }
  }

  _append(cmds) {
    for (const c of cmds) {
      this._cmds.push(c);
      this._track(c);
    }
  }

  // append segment commands, connecting to the current subpath: a leading
  // implicit start point becomes lineTo when a current point exists
  _appendSegments(start, cmds) {
    if (this._x === null) this.moveTo(start.x, start.y);
    else if (this._x !== start.x || this._y !== start.y) this.lineTo(start.x, start.y);
    this._append(cmds);
  }

  moveTo(x, y) {
    this._append([{ type: 'M', x, y }]);
  }

  lineTo(x, y) {
    if (this._x === null) return this.moveTo(x, y);
    this._append([{ type: 'L', x, y }]);
  }

  closePath() {
    if (this._cmds.length) this._append([{ type: 'Z' }]);
  }

  bezierCurveTo(x1, y1, x2, y2, x, y) {
    if (this._x === null) this.moveTo(x1, y1);
    this._append([{ type: 'C', x1, y1, x2, y2, x, y }]);
  }

  quadraticCurveTo(x1, y1, x, y) {
    if (this._x === null) this.moveTo(x1, y1);
    this._append([{ type: 'Q', x1, y1, x, y }]);
  }

  arc(x, y, r, a0, a1, counterclockwise = false) {
    this.ellipse(x, y, r, r, 0, a0, a1, counterclockwise);
  }

  ellipse(x, y, rx, ry, rotation, a0, a1, counterclockwise = false) {
    if (rx < 0 || ry < 0) throw new RangeError('ellipse: negative radius');
    const { start, cmds } = ellipseSegments(x, y, rx, ry, rotation, a0, a1, counterclockwise);
    this._appendSegments(start, cmds);
  }

  arcTo(x1, y1, x2, y2, r) {
    if (r < 0) throw new RangeError('arcTo: negative radius');
    if (this._x === null) return this.moveTo(x1, y1);
    const x0 = this._x;
    const y0 = this._y;
    const ax = x0 - x1;
    const ay = y0 - y1;
    const bx = x2 - x1;
    const by = y2 - y1;
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (!r || !la || !lb || Math.abs(cross) < 1e-9) return this.lineTo(x1, y1);

    const theta = Math.acos(Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb))));
    const dist = r / Math.tan(theta / 2);
    const t1x = x1 + (ax / la) * dist;
    const t1y = y1 + (ay / la) * dist;
    const t2x = x1 + (bx / lb) * dist;
    const t2y = y1 + (by / lb) * dist;
    // center: offset from the tangent point, perpendicular to P0->P1
    const sign = cross < 0 ? -1 : 1;
    const cx = t1x - (ay / la) * r * sign;
    const cy = t1y + (ax / la) * r * sign;
    const startAngle = Math.atan2(t1y - cy, t1x - cx);
    const endAngle = Math.atan2(t2y - cy, t2x - cx);
    this.lineTo(t1x, t1y);
    this.ellipse(cx, cy, r, r, 0, startAngle, endAngle, cross < 0);
  }

  rect(x, y, w, h) {
    this._append([
      { type: 'M', x, y },
      { type: 'L', x: x + w, y },
      { type: 'L', x: x + w, y: y + h },
      { type: 'L', x, y: y + h },
      { type: 'Z' },
      { type: 'M', x, y } // spec: rect() leaves the current point at (x, y)
    ]);
  }

  roundRect(x, y, w, h, radii) {
    if (typeof radii === 'number' && radii === 0) return this.rect(x, y, w, h);
    const [tl, tr, br, bl] = normalizeRadii(Math.abs(w), Math.abs(h), radii);
    if (w < 0 || h < 0) {
      // degenerate: fall back to a plain rect on flipped geometry
      return this.rect(x, y, w, h);
    }
    this.moveTo(x + tl.x, y);
    this.lineTo(x + w - tr.x, y);
    if (tr.x || tr.y) this.ellipse(x + w - tr.x, y + tr.y, tr.x, tr.y, 0, -Math.PI / 2, 0);
    this.lineTo(x + w, y + h - br.y);
    if (br.x || br.y) this.ellipse(x + w - br.x, y + h - br.y, br.x, br.y, 0, 0, Math.PI / 2);
    this.lineTo(x + bl.x, y + h);
    if (bl.x || bl.y) this.ellipse(x + bl.x, y + h - bl.y, bl.x, bl.y, 0, Math.PI / 2, Math.PI);
    this.lineTo(x, y + tl.y);
    if (tl.x || tl.y) this.ellipse(x + tl.x, y + tl.y, tl.x, tl.y, 0, Math.PI, Math.PI * 1.5);
    this.closePath();
    this.moveTo(x, y);
  }

  /** append another path, optionally transformed ([a,b,c,d,e,f] or {a..f}) */
  addPath(path, transform) {
    if (!(path instanceof Path2D)) throw new TypeError('addPath: expected a Path2D');
    const m = transform
      ? Array.isArray(transform)
        ? transform
        : [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f]
      : null;
    this._append(m ? transformCommands(path._cmds, m) : path._cmds.map((c) => ({ ...c })));
  }
}

/** deep-copy commands with an affine transform applied to every point */
export function transformCommands(cmds, m) {
  const out = [];
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
      case 'L': {
        const [x, y] = matApply(m, c.x, c.y);
        out.push({ type: c.type, x, y });
        break;
      }
      case 'C': {
        const [x1, y1] = matApply(m, c.x1, c.y1);
        const [x2, y2] = matApply(m, c.x2, c.y2);
        const [x, y] = matApply(m, c.x, c.y);
        out.push({ type: 'C', x1, y1, x2, y2, x, y });
        break;
      }
      case 'Q': {
        const [x1, y1] = matApply(m, c.x1, c.y1);
        const [x, y] = matApply(m, c.x, c.y);
        out.push({ type: 'Q', x1, y1, x, y });
        break;
      }
      default:
        out.push({ type: 'Z' });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// flattening

function addCubic(pts, x0, y0, x1, y1, x2, y2, x3, y3, tol2, depth) {
  const dx = x3 - x0;
  const dy = y3 - y0;
  const chord2 = dx * dx + dy * dy;
  // cross products = (distance of control point from the chord) * |chord|
  const d1 = (x1 - x0) * dy - (y1 - y0) * dx;
  const d2 = (x2 - x0) * dy - (y2 - y0) * dx;
  const err = (Math.abs(d1) + Math.abs(d2)) ** 2;
  let flat;
  if (chord2 < 1e-9) {
    // degenerate chord: flat only if the control points are also close
    const c1 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
    const c2 = (x2 - x0) ** 2 + (y2 - y0) ** 2;
    flat = Math.max(c1, c2) <= tol2;
  } else {
    // (dist1 + dist2)² <= tol² — absolute flatness in output pixels
    flat = err <= tol2 * chord2;
  }
  if (flat || depth >= 18) {
    pts.push(x3, y3);
    return;
  }
  // de Casteljau split at t = 0.5
  const ax = (x0 + x1) / 2;
  const ay = (y0 + y1) / 2;
  const bx = (x1 + x2) / 2;
  const by = (y1 + y2) / 2;
  const cx = (x2 + x3) / 2;
  const cy = (y2 + y3) / 2;
  const abx = (ax + bx) / 2;
  const aby = (ay + by) / 2;
  const bcx = (bx + cx) / 2;
  const bcy = (by + cy) / 2;
  const mx = (abx + bcx) / 2;
  const my = (aby + bcy) / 2;
  addCubic(pts, x0, y0, ax, ay, abx, aby, mx, my, tol2, depth + 1);
  addCubic(pts, mx, my, bcx, bcy, cx, cy, x3, y3, tol2, depth + 1);
}

/**
 * Flatten normalized commands into polylines. `m` (optional affine) is
 * applied to control points before subdivision, so the flatness tolerance
 * `tol` (default 0.25) is measured in output/device pixels.
 *
 * @returns {Array<{pts: number[], closed: boolean}>} flat [x0,y0,x1,y1,…]
 */
export function flattenPath(cmds, m = null, tol = 0.25) {
  if (m && matIsIdentity(m)) m = null;
  const tol2 = tol * tol;
  const polys = [];
  let pts = null;
  const p = (x, y) => (m ? matApply(m, x, y) : [x, y]);

  for (const c of cmds) {
    switch (c.type) {
      case 'M': {
        if (pts && pts.pts.length >= 4) polys.push(pts);
        const [x, y] = p(c.x, c.y);
        pts = { pts: [x, y], closed: false };
        break;
      }
      case 'L': {
        if (!pts) break;
        const [x, y] = p(c.x, c.y);
        pts.pts.push(x, y);
        break;
      }
      case 'C': {
        if (!pts) break;
        const x0 = pts.pts[pts.pts.length - 2];
        const y0 = pts.pts[pts.pts.length - 1];
        const [x1, y1] = p(c.x1, c.y1);
        const [x2, y2] = p(c.x2, c.y2);
        const [x, y] = p(c.x, c.y);
        addCubic(pts.pts, x0, y0, x1, y1, x2, y2, x, y, tol2, 0);
        break;
      }
      case 'Q': {
        if (!pts) break;
        const x0 = pts.pts[pts.pts.length - 2];
        const y0 = pts.pts[pts.pts.length - 1];
        const [qx, qy] = p(c.x1, c.y1);
        const [x, y] = p(c.x, c.y);
        // degree elevation: quadratic -> cubic
        addCubic(
          pts.pts,
          x0, y0,
          x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0),
          x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
          x, y,
          tol2, 0
        );
        break;
      }
      case 'Z': {
        if (pts) {
          if (pts.pts.length >= 4) {
            pts.closed = true;
            polys.push(pts);
          }
          // a new subpath continues from the subpath start
          pts = { pts: [pts.pts[0], pts.pts[1]], closed: false };
        }
        break;
      }
    }
  }
  if (pts && pts.pts.length >= 4) polys.push(pts);
  return polys;
}

/** point-in-path test on flattened polylines (device space) */
export function polysContain(polys, x, y, rule = 'nonzero') {
  let winding = 0;
  let crossings = 0;
  for (const poly of polys) {
    const pts = poly.pts;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y0 = pts[i * 2 + 1];
      const y1 = pts[j * 2 + 1];
      if (y0 === y1) continue;
      if (y < Math.min(y0, y1) || y >= Math.max(y0, y1)) continue;
      const x0 = pts[i * 2];
      const x1 = pts[j * 2];
      const xc = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
      if (xc > x) {
        crossings++;
        winding += y1 > y0 ? 1 : -1;
      }
    }
  }
  return rule === 'evenodd' ? (crossings & 1) === 1 : winding !== 0;
}
