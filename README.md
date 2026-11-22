# my_website

A personal site that shows four projects using their own real data: the live bot's
recorded sessions, the backtester's run outputs and IBKR caches, the OCR pipeline's
per-day results, and Lumina's cached face landmarks. It is static HTML, CSS and
JavaScript with no framework, no build step and no tracking.

| On the site | Folder | What it is |
| --- | --- | --- |
| 01 Tape Reader | `../BACK_TESTING_DATA/automated_proj_1` | OCR pipeline that read four years of a premarket livestream |
| 02 Hindsight | `../back_tester_v1/ibkr_premarket_backtester` | Tick-accurate, lookahead-free IBKR backtester |
| 03 Parity | `../VPS_trading_bot_v1` | Live trading bot held to decision parity with the backtester |
| 04 Lumina | `../REA` | On-device makeup and retouching app, hosted live at `/lumina/` |

## Preview

```sh
node tools/serve.mjs          # http://localhost:8080
node tools/serve.mjs --lan    # also prints an address for your phone on the same Wi-Fi
```

Open it over `http://localhost`, not by double-clicking `index.html`: the page loads
its data with `fetch`, which browsers block for `file://` pages.

## Before you publish

1. **Your details.** Run once with your real values (any subset works):

   ```sh
   python tools/configure.py --domain https://your-domain.com \
     --linkedin https://www.linkedin.com/in/you --github https://github.com/you \
     --email you@example.com
   ```

2. **Your words.** The short bio is in `site/index.html` under `<!-- EDIT ME -->` in
   the Contact section. The name appears in the `<title>`, the meta tags, the
   JSON-LD block, the hero (`<h1 id="heroName">`, one `<span class="line">` per
   line) and the footer.

3. **LinkedIn preview.** `site/og.png` is the 1200×630 image LinkedIn shows. After
   deploying, paste your URL into LinkedIn's Post Inspector
   (https://www.linkedin.com/post-inspector/) to refresh its cache. To regenerate
   the image: start the preview server, then
   `npm i -D playwright && npx playwright install chromium && node tools/make_og.mjs`.

## Deploy

Deploy the **`site/` folder** (not the repo root) to any static host with HTTPS.
The site's own files are about 1.4 MB; the hosted Lumina app adds about 46 MB,
mostly MediaPipe's models and WebAssembly. Every file is under 25 MB, so the
usual free tiers accept it.

- **Cloudflare Pages** (recommended): Workers & Pages → Create → Pages → upload
  the `site/` folder (or connect a Git repo and set the output directory to
  `site`). Then Custom domains → add your domain. `site/_headers` sets caching and
  the WebAssembly MIME type.
- **Netlify**: drag the `site/` folder onto app.netlify.com/drop, then Domain
  settings → add your domain. `_headers` works there too.
- **GitHub Pages**: push `site/` as the published folder (or the root of a
  `gh-pages` branch) and add a `CNAME` file containing your domain.

At your domain registrar, point the domain at the host using the DNS records the
host shows you (usually a CNAME for `www` and an A/ALIAS record or CNAME flattening
for the bare domain).

## Refresh the data

Every chart is drawn from `site/data/*.json`, which is extracted from the sibling
project folders:

```sh
python tools/build_data.py     # re-reads recordings, backtest runs, OCR results, Lumina
python tools/sync_lumina.py    # re-copies ../REA/app into site/lumina/
```

`build_data.py` only reads from the projects. The choices it showcases (the
session in the hero and Parity, the backtest run, the FLYX trade, the OCR demo
day) are constants at the top of the file. Two things in `index.html` are
written by hand, so check them after a big data change: the headline numbers
(each `data-count`) and the copy that quotes figures.

## What is deliberately left out

- **Broker account ids.** `build_data.py` replaces them with "paper" before any
  recording reaches `site/data/`.
- **Third-party images.** The only portrait is Lumina's CC0 sample. The OCR demo
  redraws the alert feed rather than showing the stream's frames.
- **Strategy parameters.** The backtest's statistics are shown; its thresholds
  are not.

## Layout

```
site/                 the deployable site
  index.html          all copy and structure
  assets/css/site.css design tokens, layout, the Lumina "studio" theme
  assets/js/          main.js (boot, nav, palette), hero.js (WebGL),
                      tape.js, hindsight.js, parity.js, lumina.js, util.js
  assets/fonts/       self-hosted fonts (SIL Open Font License)
  data/               JSON built by tools/build_data.py
  lumina/             the Lumina app, copied by tools/sync_lumina.py
tools/                build_data.py, sync_lumina.py, configure.py, serve.mjs, make_og.mjs
```

Accessibility: every canvas has a text description, everything is keyboard
reachable, and `prefers-reduced-motion` (or "Toggle motion" in the Ctrl/⌘K
palette) swaps every animation for its final frame.

## Credits

Fonts: Anybody, Instrument Sans, Instrument Serif, JetBrains Mono and Bodoni Moda,
all under the SIL Open Font License. Sample portrait: Joshua McKnight via Wikimedia
Commons, CC0. MediaPipe (inside `site/lumina/vendor/`): Google, Apache 2.0.
