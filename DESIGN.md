# Design system: the highway signboard

Source of truth: `public/ds.css` (tokens and components) and `public/ds-shell.js` (navigation shell). Loaded last on the work pages and admin so it overrides each page's own variables. Product facts live in PRODUCT.md.

## Concept

Large, high-contrast, glanceable type like a national-highway signboard. Signboard green carries the shell and the one strong action (Confirm). Yellow appears only for caution and "needs attention". Red appears only for cancel and failure. A kilometre stone at the top shows the distance left to the 2 PM target. Light ground for bright call-centre offices and phones in sun.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--ds-bg` | #f3f5f1 | page ground |
| `--ds-surface` / `--ds-surface-2` / `--ds-surface-3` | #ffffff / #eaefe8 / #dde5da | cards, table headers, pressed |
| `--ds-border` / `--ds-border-strong` | #cbd6c7 / #a9b8a4 | hairlines, outlined controls |
| `--ds-text` / `--ds-muted` / `--ds-faint` | #14201a / #46564b / #5f6f64 | text (all pass 4.5:1 on white) |
| `--ds-brand` / `--ds-brand-strong` / `--ds-brand-tint` | #0b6b3a / #084f2b / #e1f1e7 | shell, primary action, active state |
| `--ds-warn` / `--ds-warn-ink` / `--ds-warn-tint` | #ffc20e / #6b4a00 / #fff3cc | caution only |
| `--ds-danger` / `--ds-danger-tint` | #c62828 / #fbe4e4 | cancel, failure |
| `--ds-info` / `--ds-info-tint` | #1b5fa8 / #e3eef9 | links, callback |

Legacy names (`--bg`, `--surface`, `--text`, `--accent`, `--green`, `--red` ...) are pointed at these tokens so older page CSS follows the palette.

## Type

Inter (already shipped). Five sizes only, never below 12px: 12 (captions, labels), 14 (body, tables), 16 (controls, phone body), 20 (numbers, headings), 28 (the 2 PM number). Tabular figures on all numerals. Weights 400, 600, 700, 800.

## Shell and navigation

Four destinations (Aman: Work, Follow-up, Review, Reports; call centre: Work, Reports). Laptop: left rail (208px). Phone: bottom bar (64px). Sub-views are pills under the header; the old tab bar is hidden but still drives the content, so every existing handler works.

## Components

- **Lead card:** a table row becomes a card. Laptop: 12-column grid (order and reason, product/customer/phone, address and risk/age/attempts, amount and actions). Phone: stacked flex card with a 48px phone button and a 52px Confirm.
- **Call-result buttons:** Confirm solid green; Callback blue outline; DNP yellow; Prepaid link green outline; neutral outline for the rest; Cancel and Do not call red outline, last and set apart.
- **Queue chips:** pills with counts, empty ones hidden; active chip solid green. **NEXT UP** marks the first ready lead; each lead shows why it is in the queue.
- **Kilometre stone** (`.apbar`): big count of first calls left, hours left, pace, and connectivity today.
- Radius 8px, hairline borders, no shadows, no gradients. Focus ring 3px green with 2px offset. Selection, caret and scrollbars themed.

## Not yet covered

Login and landing pages keep their old look. Admin tabs other than the Daily report are recoloured and type-scaled but not restructured. No dark variant yet (tokens are structured so one can be added).
