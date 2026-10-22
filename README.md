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

Options: `--site <dev-env slug>` (default `vip-local`), `--run <slug>`, `--fresh` (ignore cache), `--until <step>`.

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

## Match scores

Both sides are scaled to 320px wide in the original's shape, then pixelmatch (threshold 0.05) runs.
Score = share of content pixels that match (flat background is ignored) × sqrt of the height ratio.
pass ≥ 85%, close ≥ 65%, otherwise fail. An original compared with itself scores 100%.
`--no-ai` clones score low on purpose: the layout is linear, so the score is a to-do list, not a grade.

## Not built yet

- Haiku for unclear sections, cached by section hash, with a token cap.
