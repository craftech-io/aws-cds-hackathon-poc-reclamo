/// <reference path="./.sst/platform/config.d.ts" />

// One stage only (docs/architecture.md §2):
//   poc → npx sst deploy --stage poc  (CI only, GitHub Actions with OIDC; never from a laptop)
//
// There is no `local` stage and `sst dev` is never run: it creates real resources in the shared
// account (docs/architecture.md §2), where other apps own their own resources. Anything
// other than `poc` is rejected before a single resource is touched. The SST CLI reports it as
// "Unexpected error occurred"; the actual message is in the config evaluation log (`--print-logs`).

const STAGES = ["poc"] as const;
type Stage = (typeof STAGES)[number];

const REGION = "us-east-1";
const PROJECT = "aws-cds-hackathon-poc-reclamo";

function assertStage(stage: string): asserts stage is Stage {
  if (!(STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `Unknown stage "${stage}". This app only knows the stage ${STAGES.join(" | ")}, deployed only by CI ` +
        `(.github/workflows/deploy.yml). Test locally with vitest and Playwright instead (docs/test-plan.md §2).`,
    );
  }
}

export default $config({
  app(input) {
    assertStage(input.stage);

    // In GitHub Actions the provider takes the credentials of the OIDC role assumed by the
    // workflow; outside CI (secret loading, `sst shell` for the seed) it uses the demos profile.
    const profile = process.env.GITHUB_ACTIONS ? undefined : "craftech-demos";

    // Same map that infra/tags.ts exposes for awsnative.* resources (aws-native has no default
    // tags). Duplicated here because sst.config.ts cannot import local modules outside run(). SST
    // adds `sst:app` and `sst:stage` on its own; they are spelled out because the CI deploy role and
    // the permissions boundary of every role are scoped by `aws:ResourceTag/sst:app`
    // (infra/bootstrap/ci-role.yaml), which must not hang on a default.
    const tags = {
      Project: PROJECT,
      Stage: input.stage,
      ManagedBy: "sst",
      Owner: "craftech",
      "sst:app": PROJECT,
      "sst:stage": input.stage,
    };

    return {
      name: PROJECT,
      home: "aws",
      removal: "remove",
      protect: false,
      version: ">=4.17.1",
      providers: {
        // Pinned on purpose: the AgentCore resources depend on the Cloud Control schema shipped
        // with these versions. Bumping either one requires an ADR.
        aws: {
          version: "7.32.0",
          region: REGION,
          profile,
          defaultTags: { tags },
        },
        "aws-native": {
          version: "1.74.1",
          region: REGION,
          profile,
        },
      },
    };
  },

  async run() {
    // Defaults every Lambda in the app inherits; a module can still override them per function.
    $transform(sst.aws.Function, (args) => {
      args.runtime ??= "nodejs22.x";
      args.architecture ??= "arm64";
      args.logging ??= { retention: "1 month" };
    });

    // Infra modules, in dependency order (docs/build-plan.md §1). Every module exists since WP-02;
    // the stubs export nothing until their work package fills them, so a later wave edits its module
    // and never this list.
    await import("./infra/tags");
    // Registers the $transform that stamps the IAM path and the CI permissions boundary on every
    // role, so it must come before any module that creates one.
    await import("./infra/ci");
    // Shared sst.Secret declarations (one place); must precede every module that links one.
    await import("./infra/secrets");
    const { channelModes } = await import("./infra/channel-modes");
    await import("./infra/dns"); // WP-04
    await import("./infra/storage"); // WP-07
    await import("./infra/malware"); // WP-07
    await import("./infra/leads"); // WP-53 (LeadNotifier, before the triggers that invoke it)
    await import("./infra/auth"); // WP-08, WP-53
    await import("./infra/auth-email"); // WP-08, WP-53
    await import("./infra/waf"); // WP-53 (the Cognito ACL; the edge ACL is created by the Router)
    await import("./infra/messaging-email"); // WP-18
    await import("./infra/messaging-whatsapp"); // WP-20
    await import("./infra/mocks"); // WP-20
    await import("./infra/workers"); // WP-20
    await import("./infra/scheduler"); // WP-31
    await import("./infra/guardrail"); // WP-22
    await import("./infra/policy"); // WP-31
    await import("./infra/agent-tool-schemas"); // WP-31
    await import("./infra/agent-tools"); // WP-31
    await import("./infra/agentcore"); // WP-31
    await import("./infra/bff"); // WP-37
    const { appUrl } = await import("./infra/dns");
    await import("./infra/web"); // WP-04 (after the BFF: the Router routes /api/* to it)
    await import("./infra/observability"); // WP-37

    return {
      stage: $app.stage,
      region: REGION,
      url: appUrl,
      channels: channelModes,
    };
  },
});
