// Haiku pattern conversion for sections the plain converter flattened badly.
// Cached by a hash of the inputs (a section is never paid for twice) and capped by a per-run token budget.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { ROOT, exists, read, write } from './guard.js';

export const MODEL = 'claude-haiku-5-5';
export const DEFAULT_BUDGET = 80000; // input + output tokens per run
const PROMPT_VERSION = 1;
const MAX_HTML_CHARS = 40000;
const MAX_TOKENS = 16000;
const CACHE_DIR = path.join(ROOT, 'cache', 'ai');

const SYSTEM = `You rebuild one section of a web page as WordPress block markup.

You get the section's cleaned HTML (the source of truth for text, links and image URLs) and a screenshot of how it looked (the source of truth for layout).

Rules:
- Output serialized block markup only: <!-- wp:name {json} --> ... <!-- /wp:name -->.
- Use only these blocks: core/group, core/columns, core/column, core/heading, core/paragraph, core/list, core/list-item, core/image, core/buttons, core/button, core/separator, core/spacer, core/navigation-link, core/social-links, core/social-link.
- Recreate the layout you see: side-by-side items become core/columns, rows of cards become columns of groups, call-to-action links become core/buttons, logo + menu rows become a group with layout {"type":"flex","justifyContent":"space-between"}.
- Keep every word of text from the HTML, verbatim. Do not invent, summarize or drop content.
- Keep image src and link href values exactly as given.
- Colors: only use the palette slugs provided, via "backgroundColor"/"textColor" attributes. Do not add a background to the outermost block; the caller wraps your markup in the section container.
- Do not wrap the whole output in one extra group unless the layout needs it.`;

const FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Short name for the layout, e.g. "hero split", "three cards", "logo + nav"' },
      markup: { type: 'string', description: 'Serialized WordPress block markup for the section contents' },
    },
    required: ['pattern', 'markup'],
    additionalProperties: false,
  },
};

export function hasCredentials() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE
    || exists(path.join(process.env.HOME || '', '.config', 'anthropic')));
}

// One budget per run, persisted so reruns of a step keep counting.
export function budget(ctx) {
  const file = path.join(ctx.dir, 'ai-usage.json');
  const state = exists(file) ? read(file) : { cap: ctx.aiBudget || DEFAULT_BUDGET, spent: 0, calls: 0, cached: 0 };
  if (ctx.aiBudget) state.cap = ctx.aiBudget;
  state.calls = 0; // per convert run; spent stays cumulative for the whole run
  state.cached = 0;
  return { state, save: () => write(file, state), left: () => state.cap - state.spent };
}

// Returns { pattern, markup, cached } or throws. lastError is fed back on a retry.
export function cacheKey({ html, screenshot, palette, lastError }) {
  const image = fs.existsSync(screenshot) ? fs.readFileSync(screenshot) : null;
  return crypto.createHash('sha256').update(JSON.stringify([MODEL, PROMPT_VERSION, html, palette, lastError || ''])).update(image || '').digest('hex');
}
export const cachePath = (key) => path.join(CACHE_DIR, `${key}.json`);

export async function patternFor({ html, screenshot, palette, lastError, b }) {
  if (html.length > MAX_HTML_CHARS) throw new Error(`section too large for the AI step (${html.length} chars > ${MAX_HTML_CHARS})`);
  const image = fs.existsSync(screenshot) ? fs.readFileSync(screenshot) : null;
  const cacheFile = cachePath(cacheKey({ html, screenshot, palette, lastError }));
  if (exists(cacheFile)) {
    b.state.cached++;
    return { ...read(cacheFile), cached: true };
  }

  if (!hasCredentials()) throw new Error('no Anthropic credentials (set ANTHROPIC_API_KEY)');
  // Rough pre-check so we never start a call the budget can't cover.
  const estimate = Math.ceil(html.length / 3) + (image ? 1600 : 0) + 4000;
  if (estimate > b.left()) throw new Error(`token cap reached (${b.state.spent}/${b.state.cap} used)`);

  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } });
  content.push({
    type: 'text',
    text: `Palette slugs: ${palette.map((p) => `${p.slug} (${p.color})`).join(', ')}\n\nSection HTML:\n${html}`
      + (lastError ? `\n\nYour previous answer failed validation: ${lastError}\nFix that and answer again.` : ''),
  });

  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: { effort: 'low', format: FORMAT },
    messages: [{ role: 'user', content }],
  });
  b.state.calls++;
  b.state.spent += (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0);
  b.save();

  if (res.stop_reason === 'refusal') throw new Error(`model declined (${res.stop_details?.category || 'no category'})`);
  if (res.stop_reason === 'max_tokens') throw new Error('answer hit max_tokens');
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('answer was not valid JSON'); }
  if (!out.markup || !/<!-- wp:/.test(out.markup)) throw new Error('answer had no block markup');
  write(cacheFile, { pattern: out.pattern, markup: out.markup });
  return { pattern: out.pattern, markup: out.markup, cached: false };
}
