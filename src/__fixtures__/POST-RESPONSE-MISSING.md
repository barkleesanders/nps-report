# Missing fixture: a real `sendemail.cfm` POST response

This file is a placeholder for an artifact that **does not exist yet**. It is
committed so the gap is visible in the repo rather than hidden behind a comment
claiming otherwise.

## What is here, and what is not

| File | What it actually is |
|---|---|
| `goga-contacts.html` | A real GET of `/goga/contacts.htm` |
| `goga-sendemail.html` | A real GET of `sendemail.cfm?o=…` — **the form** |
| `exif-gps.jpg` / `exif-nogps.jpg` | Real JPEGs, EXIF written by `exiftool` |
| _(absent)_ `sendemail-post-success.html` | The **POST response** — never captured |
| _(absent)_ `sendemail-post-rejected.html` | A validation-bounce POST response |

Both HTML fixtures are the **request side** of the flow. `parseSubmitResult()`
parses the **response** side, and has no real artifact at all — its tests feed
it hand-written strings.

This is the wrong-artifact failure mode: the fixture directory looks populated,
the tests read real files, and the function under test has still never seen real
input. "Has fixtures" is not the property that matters — "has a fixture *of the
thing this function parses*" is.

The `nps.ts` comment above `parseSubmitResult` used to assert
`VERIFIED 2026-06-16 against a real live submission`. No such response was
saved, so that verification cannot be checked, reproduced, or trusted. It has
been corrected to say what is actually true.

## Why it has not been captured

Capturing a real success response requires POSTing to
`https://www.nps.gov/common/utilities/sendmail/sendemail.cfm`, which **emails a
real National Park Service mailbox**. There is no sandbox, no test recipient,
and no way to retract it — a ranger reads whatever is sent. `send` therefore
defaults to dry-run and has never been set in automated work.

## Capture protocol (requires a deliberate human decision)

1. Pick the least-disruptive real park mailbox and write a short, honest message
   that identifies itself as a delivery test from this project and asks for no
   action.
2. Run one real submission and save the **raw POST response body**:

   ```bash
   npx tsx scripts/capture-post-response.ts --code <park> --email <you@…> --send
   ```

   (Script does not exist yet — write it to persist `res.text()` verbatim to
   `src/__fixtures__/sendemail-post-success.html`.)
3. Capture a **rejection** too — the negative control. Omit a required field so
   the form bounces. This one is free: a failed validation emails nobody.
4. Diff the two responses and find an **anchored** distinguishing feature — a
   DOM id, a container element — not a substring that appears in both.
5. Rewrite `parseSubmitResult` to key on that feature, and make the tests
   `readFileSync` both fixtures.
6. Delete this file.

## Until then

`parseSubmitResult` is documented as a heuristic, and `ok` is deliberately not
gated on the confirmation regex — see the comment in `nps.ts` for why a false
"failed" is the more expensive error here.
