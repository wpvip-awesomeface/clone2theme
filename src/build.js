// Write a block theme from the starter: theme.json from tokens, parts and front page from blocks.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, read, write, exists } from './guard.js';

export async function build(ctx, dir) {
  const tokens = read(path.join(ctx.dir, 'extract', 'tokens.json'));
  const conv = read(path.join(ctx.dir, 'convert', 'done.json'));
  const cap = read(path.join(ctx.dir, 'capture', 'done.json'));
  const themeSlug = `c2t-${ctx.run}`.slice(0, 50);
  const themeDir = path.join(dir, 'theme', themeSlug);

  fs.rmSync(path.join(dir, 'theme'), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'starter-theme'), themeDir, { recursive: true });

  const name = `${cap.title || ctx.run} (clone)`.replace(/\*\//g, '');
  const css = fs.readFileSync(path.join(themeDir, 'style.css'), 'utf8')
    .replace('{{name}}', name).replace('{{url}}', ctx.url).replace('{{slug}}', themeSlug);
  write(path.join(themeDir, 'style.css'), css);
  // Self-host the original web fonts (copied from the live site: local preview only, check the license before shipping).
  const fonts = tokens.fontFaces || [];
  for (const f of fonts) {
    fs.mkdirSync(path.join(themeDir, 'assets', 'fonts'), { recursive: true });
    fs.copyFileSync(path.join(ctx.dir, 'capture', 'assets', 'fonts', f.file), path.join(themeDir, 'assets', 'fonts', f.file));
  }
  // Tidy pass output: spacing and type scales, extra palette colors, patterns.
  const presets = exists(path.join(ctx.dir, 'convert', 'presets.json')) ? read(path.join(ctx.dir, 'convert', 'presets.json')) : null;
  write(path.join(themeDir, 'theme.json'), themeJson(tokens, presets));
  const patterns = exists(path.join(ctx.dir, 'convert', 'patterns.json')) ? read(path.join(ctx.dir, 'convert', 'patterns.json')) : [];
  fs.rmSync(path.join(themeDir, 'patterns'), { recursive: true, force: true });
  if (patterns.length) fs.mkdirSync(path.join(themeDir, 'patterns'), { recursive: true });
  for (const pt of patterns) {
    const head = `<?php\n/**\n * Title: ${pt.title.replace(/\*\//g, '')}\n * Slug: ${themeSlug}/${pt.slug}\n * Categories: ${pt.category}\n */\n?>\n`;
    fs.writeFileSync(path.join(themeDir, 'patterns', `${pt.slug}.php`), head + pt.markup.replace(/<\?/g, '&lt;?'));
  }

  const blocksOf = (id) => fs.readFileSync(path.join(ctx.dir, 'convert', 'blocks', `${id}.html`), 'utf8');
  const byRole = (role) => conv.sections.filter((s) => s.role === role).map((s) => blocksOf(s.id));
  const header = byRole('header');
  const footer = byRole('footer');
  if (header.length) write(path.join(themeDir, 'parts', 'header.html'), header.join('\n\n'));
  if (footer.length) write(path.join(themeDir, 'parts', 'footer.html'), footer.join('\n\n'));
  write(path.join(dir, 'front.html'), byRole('body').join('\n\n'));

  return { themeSlug, themeDir, fonts: fonts.length, header: header.length, footer: footer.length, body: conv.sections.length - header.length - footer.length };
}

function themeJson(t, presets) {
  const color = (slug) => (t.palette.find((p) => p.slug === slug) ? `var:preset|color|${slug}` : undefined);
  const heading = t.fonts.find((f) => f.slug === 'heading') ? 'var:preset|font-family|heading' : 'var:preset|font-family|body';
  return {
    $schema: 'https://schemas.wp.org/trunk/theme.json',
    version: 3,
    settings: {
      appearanceTools: true,
      useRootPaddingAwareAlignments: true,
      layout: { contentSize: t.contentSize, wideSize: `${Math.round(parseFloat(t.contentSize) * 1.2)}px` },
      color: { palette: [...t.palette, ...(presets?.extraColors || [])], defaultPalette: false },
      ...(presets?.spacing?.length ? { spacing: { spacingSizes: presets.spacing } } : {}),
      typography: {
        fontFamilies: t.fonts.map((f) => {
          const faces = (t.fontFaces || []).filter((x) => x.slug === f.slug);
          return faces.length ? {
            ...f,
            fontFace: faces.map((x) => ({ fontFamily: x.family, fontWeight: x.weight, fontStyle: x.style, fontDisplay: 'swap', src: [`file:./assets/fonts/${x.file}`] })),
          } : f;
        }),
        // Token sizes stay (older blocks may use them); the tidy pass's measured scale comes after.
        fontSizes: [...t.fontSizes, ...(presets?.fonts || [])].length ? [...t.fontSizes, ...(presets?.fonts || [])] : undefined,
        defaultFontSizes: !t.fontSizes.length && !presets?.fonts?.length,
        // Sizes are exact at the 1440px capture width and shrink on phones (big headlines don't overflow).
        fluid: { maxViewportWidth: '1440px', minFontSize: '14px' },
      },
    },
    styles: {
      color: { background: color('base'), text: color('contrast') },
      spacing: { padding: { left: 'var:preset|spacing|40', right: 'var:preset|spacing|40' }, blockGap: '1.25rem' },
      typography: { fontFamily: 'var:preset|font-family|body', fontSize: t.bodySize, lineHeight: '1.6' },
      elements: {
        heading: { typography: { fontFamily: heading, lineHeight: '1.2' } },
        ...headingLevels(t.headings || {}),
        link: { color: { text: color('primary') || color('contrast') } },
        button: { color: { background: color('primary') || color('contrast'), text: color('base') } },
      },
    },
    templateParts: [
      { name: 'header', title: 'Header', area: 'header' },
      { name: 'footer', title: 'Footer', area: 'footer' },
    ],
  };
}

// h1-h6 sizes and styles measured on the original, one element entry per level.
function headingLevels(levels) {
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
  return Object.fromEntries(Object.entries(levels).map(([tag, h]) => [tag, {
    typography: clean({
      fontSize: h.fontSize,
      fontFamily: h.fontFamily ? `var:preset|font-family|${h.fontFamily}` : undefined,
      fontWeight: h.fontWeight,
      fontStyle: h.fontStyle,
      lineHeight: h.lineHeight,
      letterSpacing: h.letterSpacing,
      textTransform: h.textTransform,
    }),
  }]));
}
