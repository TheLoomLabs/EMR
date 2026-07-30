# EMR

Files incoming eRačuni from the MIKROeRAČUN Portal and forwards them to the Accountant. See
`CONTEXT.md` for vocabulary and `HANDOFF.md` for project background.

## Develop

```
npm install
npm run dev            # Chrome, with hot reload
npm run dev:firefox    # Firefox, with hot reload
```

## Build

```
npm run build           # .output/chrome-mv3
npm run build:firefox   # .output/firefox-mv3
```

Load unpacked from the relevant `.output/*` directory.

## Test

```
npm test
```

## Typecheck

```
npm run compile
```
