# @ember/contact-collector

Public signup page, deployed on Vercel. A person enters a US phone number and ZIP code; the
`api/subscribe.ts` function checks the input and creates a civilian through `POST /civilians` on
the API. The page does not write the database itself.

`public/` is served as static files. The Ember mark is not committed here: `sync-assets.mjs`
copies it from `assets/brand/` into `public/` before a build and when the dev server starts.

## Run

```
pnpm --filter @ember/api dev
pnpm --filter @ember/contact-collector dev    # http://127.0.0.1:4010
```

`dev.mjs` stands in for Vercel locally. `API_URL` defaults to `http://127.0.0.1:4001` there.

## Deploy

Create the Vercel project with `apps/contact-collector` as its root directory and set `API_URL`
to the deployed API. `vercel.json` holds the rest.
