# clone2theme

**Turn any web page into an editable WordPress block theme, in about 4 minutes.**

```bash
clone2theme example.com
```

You give it a URL. It copies the page into a local WordPress site as real blocks (headings, images, buttons, columns, covers), not a screenshot or a blob of HTML. Then it opens the clone and a report showing how close it got, section by section.

## Why it's useful

- **Fast demos.** Show a prospect their own site running on WordPress, without building it by hand.
- **Editable.** Every section is core Gutenberg blocks you can click and change in the editor.
- **Honest.** The report scores each section against the original, so you know what's done and what needs a human.
- **Free by default.** No AI calls unless you ask for them (`--ai`).
- **Self-installing.** The first run checks what's missing and offers to install it.

## Quick start (Mac)

**1. Install** (once):

```bash
gh repo clone wpvip-awesomeface/clone2theme && cd clone2theme && npm ci && npm link
```

**2. Clone a page:**

```bash
clone2theme example.com
```

The first run checks for Docker, the VIP CLI and a local WordPress, and asks before installing each one. Say yes to everything, or run `clone2theme setup --yes` to accept all upfront.

**3. Look at the result.** When it finishes, two windows open:

- **The clone:** your page, live on local WordPress (`c2t-example-com.vip-local.vipdev.lndo.site`).
- **The report:** the original next to the clone for every section, with a match score.

Scores: **85%+ pass**, **65%+ close**, below that needs work.

**4. Come back to it later.** Closed the windows? Reopen both any time:

```bash
clone2theme list               # every page you've cloned, with its name
clone2theme open example-com   # reopen that clone and its report
```

The name is the domain with dots turned into dashes (`example.com` → `example-com`).

## Everyday commands

| You want to… | Run |
| --- | --- |
| Clone a page | `clone2theme example.com` |
| Clone with an AI pass for weak sections | `clone2theme example.com --ai` |
| Start over and ignore the cache | `clone2theme example.com --fresh` |
| Don't open windows when done | `clone2theme example.com --no-open` |
| See everything you've cloned | `clone2theme list` |
| Reopen a clone and its report | `clone2theme open example-com` |
| Check or fix the install | `clone2theme setup` |

`c2t` is a short alias for `clone2theme`.

## What you need

A Mac with [Homebrew](https://brew.sh) and Node 20.12+. Setup handles the rest: Docker Desktop, the VIP CLI, a browser engine, and a local VIP dev-env called `vip-local`. Node, and Docker's first launch, need a click from you; setup tells you exactly what to do.

## Make it better with AI (optional)

By default clone2theme uses no AI. Add `--ai` and it sends only the **weak sections** (raw HTML, or under 65%) to a small, fast model, **Claude Haiku**, to rebuild them as proper columns, cards and grids.

```bash
clone2theme example.com --ai
```

- **Small model, small bill.** Only weak sections go out, each one once. Results are cached, so a rerun costs nothing.
- **Hard cap.** At most 80,000 tokens per run by default (`--ai-budget 40000` to lower it). Calls that won't fit are skipped, never cut off.
- **Can't make things worse.** If the AI version scores lower than the plain one, the plain one is kept.
- **Try a bigger model** for comparison: `C2T_MODEL=claude-sonnet-5-5 clone2theme example.com --ai`.

### Where to put your API key (safely)

1. Get a key from the [Claude Console](https://console.anthropic.com) → **API keys**.
2. In the clone2theme folder, copy the example file and paste your key in:

   ```bash
   cp .env.example .env
   ```

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

3. Run with `--ai`. That's it.

**Why `.env` is safe:** it lives only on your machine. It's listed in `.gitignore`, so git never commits or pushes it. clone2theme reads it at startup and sends the key only to Anthropic's API.

**Do not:** paste the key into `.env.example`, the README, a commit, Slack, or a shared doc. If a key leaks, delete it in the Console and make a new one.

**Prefer not to keep a file?** Set it for one terminal session instead: `export ANTHROPIC_API_KEY=sk-ant-...`. An `ant auth login` profile also works.

No key? `--ai` just skips the AI pass and says so in the report. Nothing breaks.

## Troubleshooting

- **The clone shows "SSH-2.0-OpenSSH…" or won't load.** The site is fine; a system proxy (like the VIP proxy) is catching local sites in your normal browser. Open it with `clone2theme open example-com` instead: that uses a separate Chrome/Brave/Edge window that skips the proxy for local sites. Or turn the proxy off.
- **Something's missing or broken.** Run `clone2theme setup`.
- **Run one site at a time.** Parallel runs slow each other down and skew the scores.

---

<details>
<summary><strong>Advanced: rerun single steps, flags, how it works</strong></summary>

### Advanced commands

```bash
clone2theme run https://example.com --no-ai             # full pipeline (what `clone2theme <url>` calls)
clone2theme step convert --run example-com              # rerun convert and everything after it
clone2theme step convert --run example-com --only       # rerun just convert
clone2theme step convert --run example-com --section 3  # retry the AI pass for one section
```

Flags: `--site <dev-env slug>` (default `vip-local`), `--run <slug>`, `--fresh` (ignore the cache), `--until <step>`, `--ai-budget <tokens>` (default 80000), `--no-ai`.

Each run lives in `runs/<slug>/`: `report.html` (visual check) and `report.json` (small summary for agents).

### Pipeline

| Step | Does | Output |
| --- | --- | --- |
| capture | Playwright at 1440px: marks sections, freezes image URLs and visibility, tokens, screenshots, downloads images | `capture/` |
| extract | Strips scripts, attributes and hidden nodes per section; builds palette, fonts and sizes | `extract/sections/*.html`, `tokens.json` |
| convert | Flattens wrappers, then runs WordPress's own `wp.blocks.rawHandler` in the dev-env editor | `convert/blocks/*.html` |
| build | Starter theme plus `theme.json` from tokens; header and footer become template parts | `build/theme/` |
| push | Own subsite `c2t-<slug>.<env>.vipdev.lndo.site`, theme copy and activate, media import, URL rewrite, Home page | `push/state.json` |
| verify | Screenshots each local section, pixelmatch against the original, checks for broken images | `verify/sections/`, `verify/diff/` |

Every step writes `done.json`, and reruns skip finished steps. Failures land in `<step>/error.txt` and the report.

### Limits

- SVG images stay hotlinked (WordPress blocks SVG uploads). Forms, iframes and inline SVG are dropped.
- Without `--ai` the layout is mostly linear, so scores are a to-do list, not a grade.
- Each run gets its own subdomain subsite on the dev-env, which needs local app code (setup configures this).

### AI pass

With `--ai`, after the first verify, sections that came out as raw HTML or scored below 65% go to `claude-haiku-5-5` once, with the cleaned HTML and the original screenshot. The returned block markup is rebuilt with `wp.blocks.createBlock`, so it can't leave invalid blocks.

- **Score guard:** if the AI version scores no higher than the plain one, the plain one is kept and pinned (`keepPlain` in `convert/done.json`).
- **Cache:** `cache/ai/<sha256>.json`. A section is never paid for twice, and cache hits work offline.
- **Token cap:** `--ai-budget` per run, tracked in `runs/<slug>/ai-usage.json`. Calls that won't fit are skipped.
- **Credentials:** see [Where to put your API key](#where-to-put-your-api-key-safely). Without them the pass is skipped with one line in the report.
- **Model:** `C2T_MODEL` overrides the default `claude-haiku-5-5`; the cache is keyed by model.

### Match scores

Both screenshots are scaled to the original's width and top-aligned. pixelmatch runs at 320px (detail) and 48px (layout). The score is the share of content pixels that match (flat background ignored), times the square root of the height ratio, times the share of text that's readable (contrast 3:1 or better). An original compared with itself scores 100%. `SCORER` in `verify.js` versions the formula; bump it when scoring changes.

</details>
