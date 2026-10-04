# 0012: Dashboard revamp

**Status:** done
**Touches:** apps/dashboard

## Goal

The operator dashboard looks like the other Ember apps (the mark, the Gloock wordmark, Atkinson
Hyperlegible) in a light, editorial style: paper and ink, hairline rules, quiet controls, one motion
language. Sign-in is an email field, a password field and a button. No explanatory copy.

## Plan

- [x] Tokens, type and motion presets: `src/styles/theme.css`, `src/ui/motion.ts`
- [x] Shared kit restyled: buttons, segmented control and tabs, toggle, modal, toasts, panel pieces
- [x] Sign-in reduced to email and password; account creation and the demo-fill button removed
- [x] Zone list: masthead, totals row, status tabs, search, cards
- [x] Setup wizard and zone page: top bar and docked sidebar instead of floating glass panels
- [x] Inspector, agent, blast dialog, legend, scan readout, hover card
- [x] Playwright specs updated for the new sign-in (15 passing with `PW_CHANNEL=chrome`)

## Decisions

- Black is the interface color and fire red is reserved for fire, live scans, errors and unread
  marks. The previous flame gradient on every primary action made red mean nothing.
- Map encodings (blue boundary, pink radius, green route, risk and fire fills) are unchanged: they
  are data, and the legend and layers must agree.
- The faceted icon set stays; it is the brand's icon language and matches the mark.
- Sign-up is gone from the UI, so `store/session.ts` no longer stores accounts: the one built-in
  account is the only way in until the api owns accounts. Accounts created on a device with the old
  build stop working.
- Fonts come from `@fontsource/gloock` and `@fontsource/atkinson-hyperlegible` rather than the font
  files in `apps/contact-collector/public`, so the app does not reach into another app's tree.
- Map pages dock their chrome (top bar, left sidebar) instead of floating it. The map is still one
  full-window layer underneath, so camera framing (`PANEL_FRAME`, `ZONE_FRAME`) is unchanged.

## Log

- 2026-10-03: Rewrote every stylesheet and the affected components, removed the marketing hero and
  helper paragraphs, checked each view in headless Chrome and ran the e2e suite. Nothing is left
  open; wiring to services/api remains future work, as in 0010.
- 2026-10-04: Buttons and fields made slightly smaller (buttons 26/30/36px, fields 32px, sign-in
  fields 36px). A focused field now changes only its border color: no outline, no ring.
