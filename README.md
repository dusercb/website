# Daniel Collison: personal site

The source of [danielcollison.dev](https://danielcollison.dev), my personal site. It shows four projects,
each demonstrated with its own data rather than screenshots:

- **Tape Reader:** the OCR band reading one real day of a livestream's alert feed under the pipeline's
  own filter rules, and a calendar of every day the pipeline read.
- **Hindsight:** a real trade replayed bar by bar, its fills re-derived in the browser from the raw
  trades and checked against the backtest; where every setup in a sweep went; and a Monte Carlo that
  runs in the visitor's browser.
- **Parity:** the live bot's recorded event log for one session, replayed as mission control, and the
  incident that changed how it settles exits.
- **Lumina:** the face analysis behind the makeup app, and the app itself, running live at
  [danielcollison.dev/lumina](https://danielcollison.dev/lumina/).

## How it's built

Plain HTML, CSS and JavaScript: no framework, no build step, no tracking.

- **The hero** is a hand-written WebGL renderer. Forty-six stocks from one recorded premarket session
  are drawn as ridgelines, with line widths computed in screen space, trading volume as height and new
  highs of day in orange. Hovering picks the front-most ridge under the cursor.
- **Every other figure** is drawn on canvas from JSON in `site/data/`, which `tools/build_data.py`
  extracts from the projects' own outputs: the bot's session recordings, the backtester's runs and IBKR
  caches, the OCR pipeline's daily results, and Lumina's cached face landmarks.
- **Accessibility:** every figure has a text description, everything is reachable by keyboard, and
  every animation has a still fallback under `prefers-reduced-motion`.
- Fonts are self-hosted, and Lumina is served as static files from `site/lumina/`.

## Run it locally

```bash
node tools/serve.mjs     # http://localhost:8080
```

## Layout

```
site/
  index.html          content and structure
  about/              the About page: skills, ways of working, background
  assets/css/         site.css (the Lumina section re-themes itself) and about.css
  assets/js/          main.js, hero.js (WebGL), tape.js, hindsight.js, parity.js, lumina.js, util.js
  assets/fonts/       self-hosted fonts
  data/               the JSON every figure is drawn from
  lumina/             the Lumina app
tools/
  build_data.py       extracts site/data/ from the projects
  serve.mjs           local preview server
  configure.py, sync_lumina.py, make_og.mjs   site settings, copying Lumina in, the link-preview image
```

## Credits

Fonts: Anybody, Instrument Sans, Instrument Serif, JetBrains Mono and Bodoni Moda, under the SIL Open
Font License. Sample portrait: Joshua McKnight via Wikimedia Commons, CC0. MediaPipe, inside
`site/lumina/vendor/`: Google, Apache 2.0.
