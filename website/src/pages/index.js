import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';

import styles from './index.module.css';

const codeSample = `import { createClient } from 'ntk';

const app = await createClient();
const wnd = app.createWindow({ width: 800, height: 600, title: 'Hello' });
const ctx = wnd.getContext('2d');

wnd.on('mousemove', (ev) => {
  const gradient = ctx.createRadialGradient(0, 0, 10, ev.x, ev.y, 500);
  gradient.addColorStop(0, 'red');
  gradient.addColorStop(0.5, 'green');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, ctx.width, ctx.height);
});

wnd.map();`;

const features = [
  {
    title: 'APIs you already know',
    description:
      'Browser-style events (mousedown, keydown, expose, …), an HTML ' +
      'canvas-like 2d context with paths, Path2D, transforms, clipping and ' +
      'composite ops, and requestAnimationFrame for animation.',
  },
  {
    title: 'Server-side rendering',
    description:
      'The 2d context is backed by the XRender extension: composition, ' +
      'scaling, gradients, blur and glyph drawing happen on the X server, ' +
      'so a line of text costs about a byte per glyph on the wire.',
  },
  {
    title: 'Pure JavaScript',
    description:
      'Built on node-x11, a pure-JS X protocol client. Text shaping ' +
      '(fontkit), bidi, and even glyph rasterization are JavaScript — ' +
      'npm install never compiles anything.',
  },
  {
    title: 'Text, widgets and GL',
    description:
      'A TextLayout engine with wrapping and font fallback, Markdown, ' +
      'HTML, SVG and TeX widgets on top of it, plus an OpenGL 1.4-style ' +
      'context over indirect GLX.',
  },
];

function Feature({ title, description }) {
  return (
    <div className={clsx('col col--3')}>
      <div className={styles.featureCard}>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title="Home"
      description="ntk: a node.js desktop UI toolkit for X11 — canvas-like 2d and OpenGL rendering, browser-style events, pure JavaScript">
      <header className={clsx('hero hero--primary', styles.heroBanner)}>
        <div className="container">
          <Heading as="h1" className="hero__title">
            {siteConfig.title}
          </Heading>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <div className={styles.buttons}>
            <Link className="button button--secondary button--lg" to="/docs/intro">
              Get started
            </Link>
            <Link
              className="button button--outline button--secondary button--lg"
              to="/playground">
              Try the playground
            </Link>
            <Link
              className="button button--outline button--secondary button--lg"
              to="https://github.com/sidorares/ntk">
              GitHub
            </Link>
          </div>
        </div>
      </header>
      <main>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              {features.map(props => (
                <Feature key={props.title} {...props} />
              ))}
            </div>
          </div>
        </section>
        <section className={styles.codeSection}>
          <div className="container">
            <div className="row">
              <div className={clsx('col col--5', styles.codeIntro)}>
                <Heading as="h2">Write X11 UIs like web pages</Heading>
                <p>
                  Install with <code>npm install ntk</code>, connect with a
                  single call, and get retained window objects with DOM-style
                  events and a canvas-like drawing context. Noisy events are
                  coalesced into paced frames, so rendering automatically
                  adapts to the connection — even over ssh-forwarded
                  displays.
                </p>
                <p>
                  <Link to="/docs/intro">Read the introduction →</Link>
                </p>
                <p>
                  <Link to="/docs/reference">Browse the API reference →</Link>
                </p>
                <p>
                  <Link to="/playground">
                    Run it in your browser — no X server needed →
                  </Link>
                </p>
              </div>
              <div className="col col--7">
                <CodeBlock language="js">{codeSample}</CodeBlock>
              </div>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
