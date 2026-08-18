# Fix "The analysis engine could not process this image."

## What the banner actually means

That exact sentence is the **client-side fallback message** in `src/lib/analysis-api.ts`. It is shown only when the `/api/analyze` response was not OK **and** its body was not JSON with an `error` field. The server route always answers with `{ error: "<real message>" }`, so seeing the generic text means the browser never got the server's JSON — the request died before or around the handler (host function timeout, oversized request body, or a non-JSON host error page).

Two likely causes, both worth removing:

1. **Timeout.** The current chain can try 5 providers x up to 4 models x 3 attempts with 0.6-1.6s sleeps between them. On a serverless host with a ~10s function limit, a slow first provider blows the budget and the host returns its own error page, not our JSON.
2. **Payload size.** The full-resolution photo is sent as a base64 data URL (limit 4 MB in the UI, ~5.5 MB after base64). Many hosts cap request bodies around 4-6 MB and reject with a non-JSON error.

This diagnosis is inferred from the code paths, not yet confirmed against the deployed site — step 1 below makes the real cause visible either way.

## Changes

**1. Never show a blank generic error again** (`src/lib/analysis-api.ts`)
- When the body isn't JSON, read it as text and surface `HTTP <status>: <first line of body>` so the actual host/provider failure is visible instead of the catch-all sentence.

**2. Keep the run inside the host's time budget** (`src/lib/gemini-analysis.server.ts`)
- Give the whole analysis an overall deadline (~8s) and each individual model call an `AbortSignal.timeout` (~7s).
- Reduce retries per model from 3 to 2 and shorten the backoff sleeps.
- Stop walking further models/providers once the deadline passes, and return the last real provider message.

**3. Shrink the image before sending** (`src/components/analysis/analyzer.tsx`)
- After reading the file, downscale it on a canvas to a max edge of ~1280px and re-encode as JPEG (quality ~0.85) before building the data URL.
- Keeps vision quality for leaf/crop diagnosis while cutting the request body to a few hundred KB, which also speeds every provider call up.

**4. Order providers by speed**
- Put the fastest configured provider first so the deadline is rarely reached; keep the existing fallback order for the rest.

## Technical notes

- No changes to the provider chain, keys, or prompt logic — only timing, payload size, and error surfacing.
- `AbortSignal.timeout` is supported in the Worker/Netlify function runtime.
- Canvas downscaling runs in the browser, no new dependency.
