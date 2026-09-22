# 12 — UI and State Architecture

## Navigation

Primary application sections:
- Library;
- Grid;
- Favorites;
- Unmatched Updates;
- Settings.

Use a persistent app shell/sidebar rather than separate native tabs.

## Suggested layout

```text
┌───────────────────────────────────────────────────────────────┐
│ Switch Game Catalog                             status/actions │
├──────────────┬────────────────────────────────────────────────┤
│ Library      │                                                │
│ Grid         │              Route content                     │
│ Favorites    │                                                │
│ Unmatched    │                                                │
│              │                                                │
│ Settings     │                                                │
└──────────────┴────────────────────────────────────────────────┘
```

## State policy

### TanStack Query

Use for state whose source of truth is main-process data:
- game lists;
- game details;
- settings;
- MTP status;
- HTTP server status;
- install queue;
- metadata candidates.

### Local React state

Use for:
- current search input before debouncing;
- open dialog state;
- selected screenshots;
- temporary form inputs.

### Zustand

Do not introduce initially unless shared UI state becomes awkward.

Potential later use:
- persistent route-level selection;
- layout preferences;
- install tray state.

## Query keys

Examples:

```ts
['games', filters]
['game', gameId]
['settings']
['mtp-status']
['http-server-status']
['install-jobs']
```

After mutation, invalidate the smallest relevant set.

## Library page

Left/list pane:
- search;
- genre selector;
- Needs Review;
- Needs Update;
- favorite indication;
- context menu.

Right/details pane:
- cover;
- title/meta;
- version status;
- file path;
- description;
- updates/DLC list;
- install controls;
- screenshot strip.

## Grid page

Requirements:
- responsive columns;
- adjustable cover size;
- lazy image loading;
- virtualized list/grid for large catalogs;
- favorite badge;
- update/review indicators;
- click opens/selects game;
- keyboard accessibility.

## Favorites page

May reuse Library/Grid components with fixed `favorite=true` filter.

Do not duplicate data fetching logic.

## Unmatched page

Display update/DLC rows with:
- filename;
- extracted title/version;
- best candidate and confidence where available;
- manual match action;
- option to move incorrectly classified file according to existing behavior.

## Settings page

Sections:
- Library folders;
- Scanning;
- Metadata/IGDB;
- Installation;
- DBI HTTP server;
- Application/update settings;
- migration/diagnostics.

## Loading states

Prefer skeletons/status regions rather than modal blocking for normal queries.

Use modal/progress overlays only for operations requiring user focus.

## Notifications

Use toasts for:
- action succeeded;
- non-critical failures;
- copy-to-clipboard;
- server started/stopped.

Persistent failures affecting a screen belong inline, not only in transient toast.

## Theme

Dark-first theme matching the current product identity.

Use CSS variables/design tokens so a future light theme is possible.

## Accessibility

- keyboard reachable controls;
- visible focus rings;
- semantic buttons/menu items;
- dialog focus trapping;
- adequate contrast;
- avoid conveying update/favorite status only by color.

