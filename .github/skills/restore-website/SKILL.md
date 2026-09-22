---
name: restore-website
description: "Use when: a website needs to be restored to a known-good baseline such as a Saturday 11 AM snapshot, a previous working build, or a clean pre-change state. This skill compares the current app to the saved baseline, restores the earlier structure and functionality, and validates that the app is working again."
---

# Website Restore Skill

## Goal

Restore a site to a trusted earlier state such as a Saturday 11 AM version, without guessing or inventing missing content. Use the known-good baseline as the source of truth, then rebuild the app only to match that state.

## Workflow

### 1. Identify the exact restore target
- Find the last known working version or checkpoint.
- Check for:
  - project history
  - local backups
  - repo memory notes
  - previous screenshots or saved files
  - git tags or archived folders
- If no file snapshot exists, use the last stable project state recorded in memory or a trusted backup.

### 2. Compare current state with the target
- Open the current app files and identify drift:
  - HTML structure
  - CSS theme and layout
  - JS logic and events
  - data fetch logic
  - branding, nav, hero, categories, and player flows
- Map any differences to the expected Saturday 11 AM version.

### 3. Restore the baseline in priority order
Apply the earlier stable state in this order:
1. HTML page structure and layout regions
2. CSS theming, spacing, and responsive behavior
3. JavaScript event bindings and app logic
4. Data-loading behavior and API configuration
5. Branding text, navigation, and static content

### 4. Keep only working features
- Remove or revert later changes that were not part of the old baseline.
- Do not carry forward experimental or half-finished features unless the earlier version relied on them.
- Prefer a clean, functional build over a feature-rich but unstable build.

### 5. Validate the page end-to-end
Check that the restored website:
- loads without blank sections
- shows its correct branding and layout
- keeps hero/banner content and category rows intact
- has working navigation and modals
- loads content or defaults cleanly when APIs are unavailable
- does not contain obvious broken JS or missing references

### 6. Capture the restoration result
- Save the restored state in a reliable place.
- Record what was restored and why.
- Note any remaining limitations or follow-up fixes.

## Decision Points

- If a backup/snapshot exists: restore from it first.
- If no backup exists: use the latest stable repo memory, prior working files, or a saved deployment artifact as the target.
- If the issue is only visual drift: restore styling and layout without changing logic unnecessarily.
- If the issue is functional: restore the earlier DOM structure and scripts, then re-attach event listeners.
- If the target version cannot be matched exactly: restore the cleanest stable baseline that matches the user’s desired appearance and behavior.

## Completion Checks

The restore is complete only when all of these are true:
- The page loads successfully
- The overall design matches the earlier baseline or intended earlier state
- Navigation, hero, and sections appear in the expected layout
- JavaScript does not fail on startup
- No obvious missing files, broken CSS links, or invalid references remain
- The result is stable enough to be used as the new baseline

## Example prompt usage

- Restore this website to the Saturday 11 AM working version.
- Compare the current app against the last stable build and revert to the earlier design.
- Rebuild the site to match the functional state from the saved baseline.
- Restore the original homepage layout and keep only the working features from the previous version.

## Suggested related customizations

- A quick project restore prompt for “roll back to last working version”
- A front-end verification checklist for visual and functional health
- A backup-and-baseline workflow for preserving clean website states
