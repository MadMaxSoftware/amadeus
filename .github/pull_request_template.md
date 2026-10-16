## Summary

Describe the user-visible change and the evidence that it works.

## Privacy impact

- [ ] This change does not read, generate, store, or transmit new user or machine information.
- [ ] Or: I documented the information, recipient, purpose, trigger/default,
      consent/revocation, retention, and declined-consent behavior below.
- [ ] Every network-capable path uses a declared privacy-flow ID.
- [ ] No consent is broadened or reused for a different purpose or recipient.
- [ ] Declining optional consent leaves unrelated core behavior working.

Privacy-impact declaration (write `none` when the first box applies):

## Verification

- [ ] `npm run public-safety`
- [ ] `npm test`
- [ ] `npm run amadeus:self-test`
- [ ] `git diff --check`

