# Contributing to OpenHVRA

Thank you for helping. OpenHVRA is a free screening tool for disaster risk practitioners, and testing it on real places is one of the most useful things you can do.

## Reporting a problem or a result that looks wrong

[Open an issue](https://github.com/gomalhunzai/openhvra/issues/new/choose) and pick a template:

- **Bug report**: something doesn't work (an error, a button that does nothing, a broken export).
- **Results look wrong**: the app runs, but the numbers or the map don't match what you know about the place. These reports are how the methods get validated, so they're very welcome.
- **Idea or improvement**: a new feature, data source or method change.

Please always include the **OpenHVRA version** (shown under the title, and at the top of every export) and the **area** you used. The `README.txt` and `parameters.csv` from the exported ZIP (step 8) record every setting, so attaching them is the quickest way to make a report repeatable.

## Running the app locally

There's no build step and nothing to install. You need [Node.js](https://nodejs.org) 20 or newer for the local server and the tests.

```sh
git clone https://github.com/gomalhunzai/openhvra.git
cd openhvra
node serve.mjs        # then open http://localhost:8080
```

Any static web server works too.

## Running the tests

```sh
node --test           # or: npm test
```

The tests in `tests/` check the core calculations against hand-worked values. They also run automatically on every push and pull request (GitHub Actions). If you add or change a calculation, add a test with an expected value you've checked by hand, and explain in a comment where it comes from.

## Where the code is

- `js/*.js` (for example `risk.js`, `hazards.js`, `social.js`): the calculations. They don't touch the page, so the tests can run them in Node.
- `js/ui/<step>.js`: the interface for one step (`area.js` is step 1, `flood.js` step 5, and so on). A change to one step usually stays in one file.
- `js/ui/shared.js` (state and constants), `js/ui/format.js` (formatting) and `js/ui/map.js` (the map and its controls) are used by all steps.
- `js/ui/map.js` must not import the step modules, so the map always exists before the steps load. When a map control needs a step's function, the step adds it to `actions` (see the end of `area.js`).

## Making a change

1. Open an issue first for anything bigger than a small fix, so the approach can be agreed.
2. Keep each pull request to one change. Plain JavaScript modules, no build step and no new runtime dependencies unless they're discussed first.
3. Run `node --test` before opening the pull request.
4. Update `README.md` if you change what the app does or how a method works, and add an entry to `CHANGELOG.md`.

## Versions

Versions follow the rule in [CHANGELOG.md](CHANGELOG.md):

- **0.x → 0.(x+1)**: a method changed, so results may differ from the previous version. Explain the change and why in the changelog.
- **0.x.y → 0.x.(y+1)**: fixes and small additions; results must stay identical (the tests help check this).
- **1.0.0** will mark validated methods and the end of the beta.

The version number lives in `js/version.js` and `CITATION.cff`, and is stamped on every export.

## Data and licences

- The code is licensed under the GNU AGPL v3.0 (AGPL-3.0-only). By contributing, you agree your contribution is released under the same licence.
- OpenStreetMap data is © OpenStreetMap contributors (ODbL). Exports derived from it must credit OpenStreetMap.
- `data/gem-costs.json` is derived from the GEM Global Exposure Model and is **CC BY-NC-SA 4.0**, not AGPL. See [`data/README.md`](data/README.md).
- If you add a new data source, check its licence and terms of use first, and add the attribution to the README and the exports.

## Improving the map itself

Many results depend on what's mapped in OpenStreetMap: building outlines, `building:levels`, `building:material`, health facilities, rivers and streams. Mapping your area well is a direct way to improve OpenHVRA's results. See [learnosm.org](https://learnosm.org) to get started.
