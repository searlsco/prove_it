# UI Design Rules

Visual quality standards for this project. The UI design reviewer reads
this file and uses it to evaluate screenshots and code changes.

## Design System

<!-- Describe your project's design system, tokens, component library -->
<!-- Example:
- Color palette: blue-500 primary, gray-100 background
- Typography: SF Pro (iOS), Inter (web), 16px base
- Spacing: 4px grid system
- Component library: SwiftUI native / Tailwind / Material / custom
-->

## Screenshot Capture

<!-- Optional: provide hints for how the reviewer should capture the UI. -->
<!-- The reviewer will auto-detect your project type, but explicit commands -->
<!-- here take priority. Examples: -->

<!-- iOS Simulator:
```bash
xcrun simctl io booted screenshot /tmp/prove_it_screenshot.png
xcrun simctl io booted recordVideo /tmp/prove_it_recording.mov
```
-->

<!-- Web (Playwright):
```bash
npx playwright screenshot --url http://localhost:3000 /tmp/prove_it_screenshot.png
```
-->

## Navigation

<!-- Optional: map file patterns to app routes or screens so the reviewer -->
<!-- knows where to navigate when those files change. -->
<!-- Example:
- src/views/Settings.* → /settings
- Sources/App/Profile/** → Profile tab
-->

## Visual Standards

- Minimum touch target: 44x44pt (iOS) / 48x48dp (Android)
- Minimum contrast ratio: 4.5:1 (WCAG AA)
- Use design tokens for spacing, color, and typography — no magic numbers
- Consistent alignment and visual rhythm across related screens

## Accessibility Requirements

- All images and icons must have accessibility labels or alt text
- Interactive elements must have accessibility hints where purpose is non-obvious
- Support Dynamic Type / font scaling
- Color must not be the sole means of conveying information

## Exceptions / Intentional Violations

<!-- List items the reviewer has flagged that are intentional design choices. -->
<!-- The reviewer will not re-flag items listed here. -->
<!-- Example:
- Splash screen uses 36pt non-standard font (brand requirement)
- Settings toggle has 40x40pt touch target (platform constraint)
-->

<!-- TODO: Customize these rules for your project -->
