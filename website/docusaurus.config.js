// @ts-check
// Docusaurus configuration for the ntk documentation site.
// See https://docusaurus.io/docs/api/docusaurus-config

const { themes: prismThemes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'ntk',
  tagline:
    'Desktop UI toolkit for X11 — canvas-like 2d and OpenGL rendering, browser-style events, pure JavaScript',
  favicon: 'img/favicon.svg',

  url: 'https://sidorares.github.io',
  baseUrl: '/ntk/',
  trailingSlash: false,

  organizationName: 'sidorares',
  projectName: 'ntk',

  onBrokenLinks: 'throw',

  markdown: {
    // Reference pages are synced verbatim from the repo's docs/ directory and
    // are plain Markdown (may contain <placeholders> and {braces} that are not
    // valid MDX). 'detect' parses .md files as CommonMark and .mdx as MDX.
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          editUrl: 'https://github.com/sidorares/ntk/tree/master/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'light',
        disableSwitch: false,
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'ntk',
        logo: {
          alt: 'ntk logo',
          src: 'img/favicon.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docs',
            position: 'left',
            label: 'Docs',
          },
          { to: '/playground', label: 'Playground', position: 'left' },
          {
            href: 'https://github.com/sidorares/ntk',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Introduction', to: '/docs/intro' },
              { label: 'API reference', to: '/docs/reference' },
              { label: 'Playground', to: '/playground' },
            ],
          },
          {
            title: 'Project',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/sidorares/ntk',
              },
              {
                label: 'npm',
                href: 'https://www.npmjs.com/package/ntk',
              },
              {
                label: 'Issues',
                href: 'https://github.com/sidorares/ntk/issues',
              },
            ],
          },
          {
            title: 'Related',
            items: [
              {
                label: 'node-x11',
                href: 'https://github.com/sidorares/node-x11',
              },
              {
                label: 'react-x11',
                href: 'https://github.com/sidorares/react-x11',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} ntk contributors. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
      },
    }),
};

module.exports = config;
