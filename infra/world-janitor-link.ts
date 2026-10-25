// WorldJanitor by its fixed name (docs/architecture.md §1, §10; docs/architecture-guests.md §5),
// without the Function component.
//
//   WorldJanitorInvoke (Linkable)   `Resource.WorldJanitorInvoke.name` and `lambda:InvokeFunction` on the
//                                   ARN of that name. The post-confirmation trigger links this, never the
//                                   Function: a linked sst.aws.Function makes the trigger wait for the
//                                   janitor, the janitor waits for the user pool (its `auth` link and its
//                                   Cognito statement) and the pool waits for its triggers, a cycle Pulumi
//                                   never resolves. This module depends on no other resource of the app.
//
// Verify (reads only):
//   aws --profile craftech-demos lambda get-function --function-name aws-cds-hackathon-poc-reclamo-poc-world-janitor --query 'Configuration.FunctionName'

/** Fixed name: the janitor continues itself, and the trigger invokes it, without its component. */
export function worldJanitorFunctionName(app: string, stage: string): string {
  return `${app}-${stage}-world-janitor`;
}

export const worldJanitorName = worldJanitorFunctionName($app.name, $app.stage);

const caller = aws.getCallerIdentityOutput({});
const region = aws.getRegionOutput({});

export const worldJanitorArn = $util.all([region.region, caller.accountId]).apply(([regionName, account]) => `arn:aws:lambda:${regionName}:${account}:function:${worldJanitorName}`);

export const WorldJanitorInvoke = new sst.Linkable("WorldJanitorInvoke", {
  properties: { name: worldJanitorName },
  include: [sst.aws.permission({ actions: ["lambda:InvokeFunction"], resources: [worldJanitorArn] })],
});
