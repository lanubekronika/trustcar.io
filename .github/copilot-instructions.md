**Project Context**: TrustCar.io is a single-page static site. The entire app lives in `index.html` (inline CSS + minimal markup). There are no build tools, package manifests, or server-side code in the repository root.

**Big Picture**: This repo is a marketing/landing page that highlights remote vehicle inspection services. Key responsibilities you will encounter:
- UI and layout: defined inline in `index.html` inside the `<style>` block (not external CSS files).
- Hero/marketing assets: the hero image is set via the `.hero` CSS rule in `index.html`.
- Simple interactive elements: a VIN input (`.vin-input`) and two CTA buttons (`.btn-primary`, `.btn-secondary`) exist but have no JS hooks in the repo.

**Where to edit for common tasks**:
- Change hero image: update the `background: url('...')` for the `.hero` selector in `index.html`. Example replacement URL used in repo:
  `https://images.unsplash.com/photo-1765748255819-a77275fe1875?q=80&w=1034&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wx...`
- Update copy or headings: edit the textual content inside `<section class="hero">` (the `h1`, `p`, and `.buttons` markup).
- Adjust responsive rules: the mobile styles live under `@media (max-width: 768px)` in the same `<style>` block.

**Conventions & patterns to follow**:
- Keep visual changes inside `index.html` unless instructed to extract CSS/JS into new files.
- Class names are descriptive: `hero`, `hero-content`, `vin-input`, `btn`, `btn-primary`, `services`, `card` — reuse these where appropriate.
- Prefer updating the inline CSS value for small image or layout tweaks rather than introducing build tooling.

**Developer workflow (no build system)**:
- Local preview: open `index.html` in a browser, or serve the directory with a simple static server, e.g.:
  - `python3 -m http.server 8000` (then open `http://localhost:8000`)
- No tests are present — changes should be visually validated in browser on desktop & mobile widths.

**When editing programmatically**:
- Search for selectors before editing: look for `.hero` to change hero assets; update only the URL portion of `background: url('...')`.
- Keep the existing structure and spacing of rules to minimize diffs (the file uses a single inline `<style>` block).

**Integration points / external dependencies**:
- Assets: images are remote (Unsplash) and referenced by URL; there are no package or CDN manifests.
- No external APIs or server endpoints are present in the repo. If adding integrations, document them in README.

**Commit and PR tips**:
- Make small, focused commits (e.g., "Replace hero image with Unsplash photo-ID..."), include screenshot when changing visuals.
- Mention mobile responsiveness checks in PR description.

If anything in this file is unclear or you want the repository to adopt a different pattern (external CSS, JS entrypoint, or a build tool), tell me which direction you prefer and I will update these instructions accordingly.
