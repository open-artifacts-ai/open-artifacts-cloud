# PR #35 body draft (do not paste automatically)

## Gmail sign-up

Any Google account can sign up. With no `hd` (no Workspace domain) only
`gmail.com` / `googlemail.com` emails are accepted; any other email without
`hd` is refused (403 `forbidden`, "Sign up with a Gmail address or a Google
Workspace account.") and the sign-up page shows that message.

One live claim per Google account, so several Gmail accounts are several
instances. The limits are Turnstile, the per-IP create counter, and the daily
admit cap.

## Merge prerequisite

`apps/provisioner/test/node/gmail-signup-owner.test.ts` (Gmail sign-up vars
produce an instance config whose owner can sign in) needs the public branch
`selfserve/google-no-domains` (open-artifacts #1825). Against the current
`PUBLIC_PIN` (v0.136.1) it fails by design. #35 needs a public release that
includes #1825 plus a `PUBLIC_PIN` bump (tag, sha, regenerated lockfile) before
merge.

## Issue #40 comment draft

Gmail accounts can sign up. One live claim per Google account: several Gmail
accounts means several instances. Abuse limits are Turnstile, the per-IP create
counter, and the daily admit cap. Non-Gmail emails without a Workspace domain
are refused.
