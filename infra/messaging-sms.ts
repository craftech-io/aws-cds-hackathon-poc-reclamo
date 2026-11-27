// The SMS code's send (docs/architecture-guests.md §17): `sns:Publish` straight to a phone number, for
// the `Bff` only. Publishing to a number has no resource to scope (IAM evaluates it on `*`), so a deny
// on every topic (`arn:aws:sns:*:*:*`) keeps the grant to direct SMS: it can never publish to a topic of
// this app or of another one in the shared account. The boundary allows it (infra/bootstrap/ci-role.yaml
// `DirectSmsPublish`, with its own deny on topics outside the app). Pure data: infra/iam-capabilities.test.ts
// and infra/bff-spec.test.ts check it.
export const SMS_TOPICS_ARN = "arn:aws:sns:*:*:*";

export const SMS_PUBLISH_PERMISSIONS = [
  { actions: ["sns:Publish"], resources: ["*"] },
  { effect: "deny" as const, actions: ["sns:Publish"], resources: [SMS_TOPICS_ARN] },
];
