// Font setup for the playground bundle: the browser has no fontconfig, so
// the demos run on a StaticFontSource loaded with DejaVu faces embedded in
// the bundle (esbuild loader '.ttf': 'binary' turns each import into a
// Uint8Array). setupFonts() installs the source as the process-wide default
// (setDefaultFontSource), so plain `createClient()` in demo code just works;
// the returned source can also be passed explicitly via
// `createClient({ fontSource })`.
import DejaVuSans from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf';
import DejaVuSansBold from 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf';
import DejaVuSansOblique from 'dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf';
import DejaVuSerif from 'dejavu-fonts-ttf/ttf/DejaVuSerif.ttf';
import DejaVuSansMono from 'dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf';
import { StaticFontSource, setDefaultFontSource } from 'ntk';

let source = null;

export function setupFonts() {
  if (source) return source;
  source = new StaticFontSource();
  source.add(DejaVuSans, { family: 'DejaVu Sans' });
  source.add(DejaVuSansBold, { family: 'DejaVu Sans' });
  source.add(DejaVuSansOblique, { family: 'DejaVu Sans' });
  source.add(DejaVuSerif, { family: 'DejaVu Serif' });
  source.add(DejaVuSansMono, { family: 'DejaVu Sans Mono' });
  source.alias('sans-serif', 'DejaVu Sans');
  source.alias('serif', 'DejaVu Serif');
  source.alias('monospace', 'DejaVu Sans Mono');
  setDefaultFontSource(source);
  return source;
}
