# Alisio style guide

Use this guide when designing Alisio documentation and product surfaces. It defines the brand
palette, theme roles, gradients, semantic states, and accessibility boundaries that keep the
experience clear in light and dark mode.

## Brand foundation

The core identity uses three cool tones and one deep anchor:

| Name | Token | Value | Role |
| --- | --- | --- | --- |
| Alisio Light Cyan | `--alisio-cyan-light` | `#60E0F9` | Highlights, glows, badges, focus |
| Alisio Sky | `--alisio-sky` | `#07C4F9` | Accents, active states, dark-mode primary |
| Alisio Blue | `--alisio-blue` | `#01A5F7` | Light-mode primary |
| Alisio Deep Ocean | `--alisio-deep-navy` | `#031C36` | Dark secondary surfaces and gradients |

The full blue scale supports controls, links, borders, badges, cards, code blocks, navigation,
selection, focus, and gradients:

| Scale | Value | Scale | Value |
| --- | --- | --- | --- |
| 50 | `#EFFCFF` | 500 | `#07C4F9` |
| 100 | `#D8F7FE` | 600 | `#01A5F7` |
| 200 | `#B6F0FC` | 700 | `#087BC1` |
| 300 | `#85E7FB` | 800 | `#075A92` |
| 400 | `#60E0F9` | 900 | `#06345F` |
| 950 | `#031C36` |  |  |

## Light theme

Keep documentation bright and technical: use a white or slightly blue background, not a saturated
blue page surface.

| Role | Value |
| --- | --- |
| Primary / hover | `#01A5F7` / `#087BC1` |
| Accent / highlight | `#07C4F9` / `#60E0F9` |
| Background / secondary | `#F8FCFF` / `#EFF9FE` |
| Surface / hover | `#FFFFFF` / `#E8F7FD` |
| Border / strong border | `#CDECF8` / `#8EDAF2` |
| Text / secondary / muted | `#06233D` / `#45647A` / `#6F8798` |
| Code background | `#F0F8FC` |

Typography belongs on the dark text roles, with `#06233D` as the default. Use secondary and muted
text only for supporting information; do not use a brand blue as the general text color.

## Dark theme

Use navy rather than pure black so the brand retains depth. In dark mode, Sky becomes primary for
better presence against the Midnight background.

| Role | Value |
| --- | --- |
| Primary / hover | `#07C4F9` / `#60E0F9` |
| Accent / highlight | `#01A5F7` / `#60E0F9` |
| Background / secondary | `#020E1C` / `#031C36` |
| Surface / hover | `#062747` / `#08385F` |
| Border / strong border | `#0A456E` / `#087BC1` |
| Text / secondary / muted | `#EDF9FF` / `#A8CDDD` / `#7297A9` |
| Code background | `#03182D` |

## Surfaces and components

- **Pages:** use the theme background; in light mode it remains near-white, and in dark mode it is
  Midnight.
- **Cards and elevated areas:** use the surface token, with the matching hover surface and border.
- **Primary actions:** use the brand gradient or the primary role. Keep the deep navy text treatment
  on light-cyan buttons.
- **Links and active navigation:** use the primary/sky hierarchy, with a distinct hover state.
- **Code:** use the dedicated code background rather than a generic card surface.
- **Focus and selection:** preserve the light-cyan focus and selection treatment so keyboard users
  can identify their location.

## Gradients

Reserve gradients for prominent brand moments, such as hero areas and primary calls to action.

```css
/* Brand */
linear-gradient(135deg, #60E0F9 0%, #07C4F9 45%, #01A5F7 100%)

/* Deep heading */
linear-gradient(135deg, #60E0F9 0%, #01A5F7 45%, #075A92 100%)

/* Dark theme */
linear-gradient(135deg, #031C36 0%, #06345F 45%, #01A5F7 100%)
```

## Semantic states

Do not use blue for every meaning. Reserve semantic colors for status and keep the Alisio cyan for
information.

| State | Value | Example |
| --- | --- | --- |
| Success | `#22C78A` | Tool completed |
| Warning | `#F5B942` | Permission required |
| Error | `#F05D6C` | Tool failed |
| Info | `#07C4F9` | Information |
| Focus | `#60E0F9` | Keyboard focus |

## Accessibility and asset rules

- Keep text on the theme text roles and preserve visible focus indicators; test contrast whenever a
  token is introduced or changed.
- Do not communicate a status through color alone: pair it with clear wording and, where useful, an
  icon.
- Respect reduced-motion preferences. Decorative video or animation must pause or provide a static
  visual fallback.
- Use responsive assets with an explicit intrinsic size or stable container. Provide an image poster
  for video, useful alternative text for meaningful images, and avoid text baked into decorative
  artwork.

## Do and do not

**Do** use `#01A5F7` as the light primary, `#07C4F9` as the accent, and `#60E0F9` as the highlight.
Use the dark hierarchy on Midnight surfaces.

**Do not** use saturated blue as the default light-page background, pure black as the dark-page
background, or brand blue in place of semantic success, warning, and error states.
