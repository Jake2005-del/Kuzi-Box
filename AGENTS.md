# Kuzi Box AI agent instructions

## Project

This repo is a static PWA for a movie and TV streaming app. Keep it as a vanilla HTML/CSS/JS app unless the user explicitly requests a framework migration.

## Architecture

- index.html: shell UI, modals, player layout, content sections
- script.js: app logic, fetches, state, rewards, auth checks, player behavior
- style.css: dark premium theme and responsive styling
- sw.js: service worker cache/offline strategy
- manifest.json: PWA metadata

## Working rules

- Serve the app over HTTP. Do not treat file:// as a valid environment for testing; fetches and service workers will not work properly.
- Follow the existing patterns already in the app: global state variables, DOM IDs, localStorage keys, and notification flow.
- Preserve existing IDs and class names unless a change explicitly requires new markup.
- Keep secrets out of client code. Public TMDB and Supabase anon keys are fine; do not add private credentials.
- Prefer targeted edits in the current structure instead of introducing new frameworks or large refactors.

## Conventions that matter

- The app boots on DOMContentLoaded and initializes from the existing setup flow.
- State is managed through globals like userSession, activeMovie, activeCategoryTag, activeServer, and isVideoPlaying.
- User feedback should go through showSiteNotification() and addNotification().
- Local storage keys already in use include kuzi_notifications, kuzi_child_mode, and kuzi_ref_code.
- Check window.supabase before any Supabase call.
- If a feature touches video playback, follow the current direct-stream and fallback-provider logic already used in the app.

## Run and validate

Use a local server, for example:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

Before finishing a change, verify:

- the page loads without console errors
- API calls hit the expected endpoints
- the service worker still registers
- the cache version is bumped when changing static files in sw.js
- the app still matches the existing dark PWA design

## Common pitfalls

- Service worker cache can keep stale static files. Update CACHE_NAME in sw.js when changing HTML, CSS, or JS.
- The app is designed for HTTP and may fail silently if opened directly from disk.
- Public API keys are intentionally exposed in the browser; keep any secrets off the client.
- Streaming provider failover is brittle; preserve the current provider-order behavior rather than replacing it with a completely different flow.

## Related guidance

- Restore to a known-good baseline using [.github/skills/restore-website/SKILL.md](.github/skills/restore-website/SKILL.md).
- Keep the dark premium streaming aesthetic consistent with the existing UI when making design changes.

## Preferred change style

- Prefer small, direct edits inside the current HTML, CSS, and script structure.
- Keep behavior aligned with the current app instead of creating new abstractions or rewrite-heavy refactors.
- If a change affects catalog loading, auth, or playback, verify the corresponding flow in the browser rather than relying only on syntax checks.
