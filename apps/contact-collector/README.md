# @ember/contact-collector

Public signup page. A person enters a US phone number and ZIP code; the worker checks the
input and creates a civilian through `POST /civilians` on the API.

`API_URL` in `wrangler.jsonc` points at the local API (`http://127.0.0.1:4001`). Change it
for a deployed API. The page does not write the database itself.

```
pnpm --filter @ember/api dev
pnpm --filter @ember/contact-collector dev
```
