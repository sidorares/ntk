import Drawable from './drawable.js';

// Thin wrapper over core X drawing requests (no XRender). Mostly useful for
// debugging; prefer the '2d' context.
class RenderingContextX11 {
  constructor(window) {
    const X = window.X;
    this.gc = X.AllocID();
    const white = X.display.screen[0].white_pixel;
    const black = X.display.screen[0].black_pixel;
    X.CreateGC(this.gc, window.id, { foreground: white, background: black });
    this.window = window;
  }

  putImage(data, x, y) {
    this.window.X.PutImage(2, this.window.id, this.gc, data.width, data.height, x, y, 0, 24, data.data);
  }

  point(p) {
    this.window.X.PolyPoint(0, this.window.id, this.gc, [p.x, p.y]);
  }

  setForeground(color) {
    this.window.X.ChangeGC(this.gc, { foreground: color });
  }

  setBackground(color) {
    this.window.X.ChangeGC(this.gc, { background: color });
  }

  polyLine(pts) {
    const coords = [];
    for (const p of pts) coords.push(p.x, p.y);
    this.window.X.PolyLine(0, this.window.id, this.gc, coords);
  }

  fillRectangle(r) {
    const coords = [Math.trunc(r.left), Math.trunc(r.top), Math.trunc(r.width), Math.trunc(r.height)];
    this.window.X.PolyFillRectangle(this.window.id, this.gc, coords);
  }

  rectangle(r) {
    const coords = [Math.trunc(r.left), Math.trunc(r.top), Math.trunc(r.width), Math.trunc(r.height)];
    this.window.X.PolyRectangle(this.window.id, this.gc, coords);
  }

  copy(dst) {
    this.window.X.CopyArea(this.window.id, dst.id, this.gc, 0, 0, 0, 0, 1000, 1000);
  }

  drawText(text, x, y) {
    this.window.X.PolyText8(this.window.id, this.gc, x, y, [text]);
  }
}

// register context
Drawable.renderingContextFactory['x11'] = (window) => new RenderingContextX11(window);

export default RenderingContextX11;
