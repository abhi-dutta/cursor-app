# App spec reference

`spec/app.spec.yaml` drives the whole UI. Every key is optional except `version` and `app.name`;
missing keys use the defaults in `backend/src/spec.js`. Invalid specs are rejected with a list of
every problem (`npm run validate-spec`), and the backend refuses to start with an invalid spec.

> In YAML flow mappings (`{ title: x, description: y }`) quote any value that contains a comma or colon.

| Key | Values | Notes |
|---|---|---|
| `version` | `1` | schema version |
| `app.name` / `tagline` / `logo` | string | logo is an emoji |
| `theme.mode` | `light` \| `dark` | sets the browser `color-scheme` |
| `theme.primaryColor` `accentColor` `background` `surface` `textColor` | hex, e.g. `#0092e4` | |
| `theme.font` | `sans` `serif` `mono` `rounded` | system font stacks, no downloads |
| `theme.radius` | 0-40 | corner radius in px |
| `banner.enabled` / `tone` / `text` | bool / `info` `success` `warning` / string | strip below the header |
| `hero.layout` | `centered` \| `split` | |
| `hero.title` `subtitle` `emoji` | string | empty title hides the hero |
| `hero.cta` | `{ label, target }` | `target` must be a section `id` |
| `sections[]` | ordered list | rendered top to bottom; each needs a unique `id` and a `type` |
| `footer.text` / `showBuildInfo` | string / bool | build info = web version, api version, pod, spec hash |
| `catalog.items[]` | `{ id, name, price, description?, emoji?, tag? }` | seed data for `/api/items` |
| `catalog.allowEdit` | bool | shows add/delete UI (in-memory, per pod) |

## Section types

| `type` | Fields |
|---|---|
| `features` | `title`, `subtitle`, `columns` (1-4), `items[]: { icon, title, description }` |
| `stats` | `title`, `subtitle`, `metrics[]`: any of `version pod environment uptime requests items` (live from the API) |
| `testimonials` | `title`, `subtitle`, `columns` (1-4), `items[]: { quote, name, role?, avatar?, rating? }` — `rating` is an integer 1-5, shown as ★/☆ |
| `catalog` | `title`, `subtitle`, `layout` (`grid` \| `list`), `showPrice` |
| `text` | `title`, `subtitle`, `body` |

## Examples

`spec/examples/` has ready-made variants. Swap one in and watch the page change:

```bash
npm run spec:use              # list
npm run spec:use dark-ocean   # copies it over spec/app.spec.yaml (after validating)
git checkout spec/app.spec.yaml   # go back
```

## Adding a new section type

1. renderer in `frontend/public/app.js` -> `SECTION_RENDERERS`
2. type + validation in `backend/src/spec.js`
3. a row in the table above, a test in `backend/test/spec.test.js`
