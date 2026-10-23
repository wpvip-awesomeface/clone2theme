# clone2theme (c2t)

Clone a live page into a WordPress block theme on a local VIP dev-env. One Node CLI, no server.
Each run writes `runs/<slug>/report.html` (visual check) and `report.json` (small summary for agents).

```bash
npm ci
node bin/c2t.js run https://example.com --no-ai          # full pipeline, zero model calls
node bin/c2t.js step convert --run example-com           # rerun convert and everything after
node bin/c2t.js step convert --run example-com --only    # rerun just convert
node bin/c2t.js open example-com                         # open report.html
node bin/c2t.js list
```

Options: `--site <dev-env slug>` (default `vip-local`), `--run <slug>`, `--fresh` (ignore cache), `--until <step>`, `--ai-budget <tokens>` (default 80000), `--no-ai`.

## Pipeline

| step | does | output |
| --- | --- | --- |
| capture | Playwright 1440px: marks sections, freezes image URLs/visibility, tokens, screenshots, downloads images | `capture/` |
| extract | strips scripts/attrs/hidden nodes per section, builds palette/fonts/sizes | `extract/sections/*.html`, `tokens.json` |
| convert | flattens wrappers, then WordPress's own `wp.blocks.rawHandler` in the dev-env editor | `convert/blocks/*.html` |
| build | starter theme + `theme.json` from tokens; header/footer sections become template parts | `build/theme/` |
| push | own subsite `c2t-<slug>.<env>.vipdev.lndo.site`, theme copy + activate, media import, URL rewrite, Home page | `push/state.json` |
| verify | screenshots each local section, pixelmatch vs the original, broken images | `verify/sections/`, `verify/diff/` |

Every step writes `done.json`; reruns skip finished steps. Failures land in `<step>/error.txt` and the report.

## Requirements and gotchas

- A running VIP dev-env with **local app code** (`vip dev-env info`); the theme is copied into `<app code>/themes/`.
- Local pages are opened with `--proxy-server=direct://` so a system SOCKS tunnel (ssh -D) doesn't swallow `*.lndo.site`.
- Each run gets its own subdomain subsite (the root site of a big network may not resolve).
- SVG images stay hotlinked (WordPress blocks SVG uploads). Forms, iframes and inline SVG are dropped.
- `--no-ai` output is content-accurate but linear (no columns/cards). Haiku pattern matching for those is build step 4.

## AI pass (Haiku)

Without `--no-ai`, after the first verify, sections that came out as raw HTML or score below 65% go to
`claude-haiku-5-5` once, with the cleaned HTML plus the original screenshot. It returns block markup
(structured output), which is parsed and rebuilt with `wp.blocks.createBlock` in the editor so small
markup slips can't leave invalid blocks. Unknown blocks or mostly-raw-HTML answers get one retry with the
error, then fall back to the plain conversion and land in "needs a human".

- Score guard: after verify, a Haiku rebuild that scores no higher than the plain conversion is swapped back
  (`convert/blocks/<id>.plain.html`) and pinned to plain in `convert/done.json` (`keepPlain`), so reruns skip it.
  `step convert --section <n>` retries Haiku for a pinned section. The guard trusts the score: it can keep a plain
  version that looks worse (e.g. unreadable text on a dark background) if Haiku's layout is a different height.
- Cache: `cache/ai/<sha256 of model, prompt version, html, palette, screenshot>.json`. A section is never paid for twice, and cache hits work offline.
- Token cap: `--ai-budget` per run (input + output, tracked in `runs/<slug>/ai-usage.json`). Calls that won't fit are skipped, not truncated.
- Credentials: `ANTHROPIC_API_KEY` in `.env` next to `package.json` (copy `.env.example`; gitignored), the shell env, or an `ant auth login` profile. Without them the pass is skipped with one report line.

## Match scores

Both sides are scaled to the original's width (no stretching), top-aligned, and the local side is cut or
padded to the original's height. pixelmatch (threshold 0.05) runs at 320px (detail) and 48px (layout).
Score = average share of content pixels that match (flat background ignored) × sqrt of the content-height ratio.
pass ≥ 85%, close ≥ 65%, otherwise fail. An original compared with itself scores 100%.
`--no-ai` clones score low on purpose: the layout is linear, so the score is a to-do list, not a grade.

## Not built yet

- Haiku for unclear sections, cached by section hash, with a token cap.
