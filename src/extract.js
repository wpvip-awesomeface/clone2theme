// Clean each marked section offline and turn raw tokens into a theme palette.
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './browser.js';
import { read, write } from './guard.js';

export async function extract(ctx, dir) {
  const capDir = path.join(ctx.dir, 'capture');
  const dom = read(path.join(capDir, 'dom.json'));
  const raw = fs.readFileSync(path.join(capDir, 'raw.html'), 'utf8');

  const browser = await launch();
  let cleaned;
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route('**/*', (r) => r.abort());
    await page.setContent(raw, { waitUntil: 'domcontentloaded' });
    cleaned = await page.evaluate(cleanSections);
  } finally {
    await browser.close();
  }

  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
  const sections = dom.sections.map((s) => {
    const c = cleaned[s.id] || { html: '', words: 0, images: 0, links: 0 };
    write(path.join(dir, 'sections', `${s.id}.html`), c.html);
    return { ...s, words: c.words, images: c.images, links: c.links, forms: c.forms || 0, bytes: c.html.length };
  });
  const tokens = buildTokens(dom);
  write(path.join(dir, 'sections.json'), sections);
  write(path.join(dir, 'tokens.json'), tokens);
  return { sections: sections.length, empty: sections.filter((s) => !s.bytes).map((s) => s.id), tokens };
}

// Runs in a JS-disabled copy of the captured DOM.
function cleanSections() {
  const KEEP = new Set(['href', 'src', 'alt', 'width', 'colspan', 'rowspan', 'title', 'target', 'data-c2t-id', 'data-label', 'data-placeholder', 'data-button']);
  const DROP = 'script,style,noscript,link,meta,template,svg,iframe,form,input,select,textarea,button:empty,[data-c2t-hidden]';
  const out = {};
  document.querySelectorAll('[data-c2t-section]').forEach((sec) => {
    const el = sec.cloneNode(true);
    // Forms: search forms become a marker the converter turns into core/search; other forms keep
    // their visible text (labels, headings) and lose the fields, and are counted for the report.
    let forms = 0;
    el.querySelectorAll('form').forEach((f) => {
      const input = f.querySelector('input[type="search"], input[name="q"], input[name="s"], input[name="keywords"], input[name="query"]');
      if (f.matches('[role="search"]') || f.querySelector('[role="search"]') || input) {
        const m = document.createElement('c2t-search');
        const label = (f.querySelector('label')?.textContent || input?.getAttribute('aria-label') || 'Search').trim().replace(/\s+/g, ' ');
        const btn = f.querySelector('button, input[type="submit"]');
        m.setAttribute('data-label', label);
        m.setAttribute('data-placeholder', input?.getAttribute('placeholder') || '');
        m.setAttribute('data-button', (btn?.textContent || btn?.getAttribute('value') || btn?.getAttribute('aria-label') || 'Search').trim());
        if (f.getAttribute('data-c2t-id')) m.setAttribute('data-c2t-id', f.getAttribute('data-c2t-id'));
        m.textContent = label; // keeps empty-wrapper cleanup from removing it
        f.replaceWith(m);
      } else {
        forms++;
        const d = document.createElement('div');
        d.append(...f.childNodes);
        f.replaceWith(d);
      }
    });
    el.querySelectorAll(DROP).forEach((n) => n.remove());
    el.querySelectorAll('picture source').forEach((n) => n.remove());
    el.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('data-c2t-src');
      if (src) img.setAttribute('src', src);
      else img.remove();
    });
    // Buttons that are really links become links so they survive conversion.
    // JS buttons keep their place and box (id) as links; drawn as boxes they become core/button.
    el.querySelectorAll('button').forEach((b) => {
      const a = document.createElement('a');
      a.setAttribute('href', '#');
      a.textContent = b.textContent.trim();
      if (b.getAttribute('data-c2t-id')) a.setAttribute('data-c2t-id', b.getAttribute('data-c2t-id'));
      b.replaceWith(a);
    });
    [el, ...el.querySelectorAll('*')].forEach((n) => {
      [...n.attributes].forEach((a) => { if (!KEEP.has(a.name)) n.removeAttribute(a.name); });
    });
    // Drop wrappers left empty after cleaning.
    for (let pass = 0; pass < 3; pass++) {
      el.querySelectorAll('div,span,section,article,li,p,a').forEach((n) => {
        if (!n.textContent.trim() && !n.querySelector('img')) n.remove();
      });
    }
    const words = (el.textContent.trim().match(/\S+/g) || []).length;
    out[sec.getAttribute('data-c2t-section')] = {
      html: el.innerHTML.replace(/\n\s*\n+/g, '\n').trim(),
      words,
      images: el.querySelectorAll('img').length,
      links: el.querySelectorAll('a').length,
      forms,
    };
  });
  return out;
}

const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).map(Number);
const hex = (s) => {
  const [r, g, b, a = 1] = rgb(s);
  if (r === undefined || a < 0.5) return null;
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
};
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const sat = (h) => {
  const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (Math.max(...v) - Math.min(...v)) / 255;
};
// Content width of one section, symmetric around the center: viewport minus the smaller gutter, twice.
export function sectionWidth(s, vw = 1440) {
  if (!s.box) return null;
  // An image bleeding off one edge doesn't make the section full width: use the other side's gutter.
  const sides = [s.box.left, vw - s.box.right].filter((g) => g >= 16);
  return sides.length ? Math.round(vw - 2 * Math.min(...sides)) : null;
}
const firstFamily = (f) => (f || '').split(',')[0].replace(/["']/g, '').trim();

export function buildTokens(dom) {
  const t = dom.tokens;
  const base = hex(dom.bodyBg) || hex(t.backgrounds[0]?.value || '') || '#ffffff';
  // Text color that reads best on the base, not just the most common one.
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const contrast = t.text.map((c) => hex(c.value)).filter(Boolean).find((h) => ratio(h, base) >= 4.5)
    || (lum(base) < 0.2 ? '#ffffff' : '#111111');
  const seen = new Set([base, contrast]);
  // Brand colors: most-used saturated colors from buttons, backgrounds, then text.
  const brand = [...t.buttons, ...t.backgrounds, ...t.text]
    .map((c) => hex(c.value))
    .filter((h) => h && !seen.has(h) && sat(h) > 0.15 && (seen.add(h), true));
  const neutrals = t.backgrounds.map((c) => hex(c.value)).filter((h) => h && !seen.has(h) && sat(h) <= 0.15 && (seen.add(h), true));
  const palette = [
    { slug: 'base', name: 'Base', color: base },
    { slug: 'contrast', name: 'Contrast', color: contrast },
    ...brand.slice(0, 3).map((color, i) => ({ slug: ['primary', 'secondary', 'tertiary'][i], name: ['Primary', 'Secondary', 'Tertiary'][i], color })),
    ...neutrals.slice(0, 2).map((color, i) => ({ slug: `neutral-${i + 1}`, name: `Neutral ${i + 1}`, color })),
  ];
  const bodyFont = t.fonts[0]?.value || 'system-ui, sans-serif';
  const headingFont = t.headingFonts[0]?.value || bodyFont;
  const sizes = [...new Set(t.fontSizes.map((s) => parseFloat(s.value)).filter((n) => n >= 12 && n <= 96))].sort((a, b) => a - b);
  // Heading styles per level; families map to the body/heading presets when they match.
  const famSlug = (f) => (firstFamily(f) === firstFamily(headingFont) ? 'heading' : firstFamily(f) === firstFamily(bodyFont) ? 'body' : null);
  const headings = Object.fromEntries(Object.entries(dom.headings || {}).map(([tag, h]) => [tag, {
    fontSize: h.fontSize,
    fontFamily: famSlug(h.fontFamily),
    fontWeight: h.fontWeight,
    fontStyle: h.fontStyle === 'normal' ? undefined : h.fontStyle,
    lineHeight: h.lineHeight === 'normal' ? undefined : (parseFloat(h.lineHeight) / parseFloat(h.fontSize)).toFixed(2),
    letterSpacing: h.letterSpacing === 'normal' ? undefined : h.letterSpacing,
    textTransform: h.textTransform === 'none' ? undefined : h.textTransform,
  }]));
  const faces = (dom.fontFaces || []).map((f) => ({ ...f, slug: famSlug(f.family) })).filter((f) => f.slug);
  const widths = t.maxWidths.map((w) => parseFloat(w.value)).filter((n) => n >= 900 && n <= 1600);
  // Measured content width wins over max-width tokens: the median of wide sections' content boxes.
  const measured = dom.sections.map((s) => sectionWidth(s, dom.viewport || 1440)).filter((n) => n >= 900).sort((a, b) => a - b);
  if (measured.length) widths.unshift(measured[Math.floor(measured.length / 2)]);
  return {
    palette,
    fonts: [
      { slug: 'body', name: firstFamily(bodyFont) || 'Body', fontFamily: bodyFont },
      ...(firstFamily(headingFont) !== firstFamily(bodyFont) ? [{ slug: 'heading', name: firstFamily(headingFont), fontFamily: headingFont }] : []),
    ],
    fontSizes: sizes.slice(0, 6).map((n, i) => ({ slug: ['small', 'medium', 'large', 'x-large', 'xx-large', 'huge'][i], name: `${n}px`, size: `${n}px` })),
    headings,
    fontFaces: faces,
    bodySize: t.fontSizes[0]?.value || '16px',
    contentSize: `${widths[0] || 1200}px`,
    darkBase: lum(base) < 0.2,
  };
}
