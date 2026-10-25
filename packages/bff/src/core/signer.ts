// AWS Signature V4 for a mock's Function URL (auth type `AWS_IAM`, service `lambda`). The calling
// role needs `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` with
// `lambda:InvokedViaFunctionUrl = true` on the mock (capabilities `MOCK_CORE` / `MOCK_NETWORK`,
// docs/architecture.md §14). Credentials come from the Lambda's own role through the default
// provider chain; nothing is read from the environment by this code. The networks client reuses it.
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";

export type SignerCredentials = ConstructorParameters<typeof SignatureV4>[0]["credentials"];
type HttpRequestToSign = Parameters<SignatureV4["sign"]>[0];

export interface SignableRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The headers to send, `authorization` and `x-amz-*` included. */
export type RequestSigner = (request: SignableRequest) => Promise<Record<string, string>>;

export interface SigV4SignerOptions {
  readonly credentials?: SignerCredentials;
  /** Region to sign for; by default the one in the Function URL host. */
  readonly region?: string;
  /** Test seam for a fixed signature. */
  readonly signingDate?: () => Date;
}

const FUNCTION_URL_HOST = /^[a-z0-9]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/;

/** `us-east-1` of `https://<id>.lambda-url.us-east-1.on.aws/`. */
export function functionUrlRegion(url: URL): string | undefined {
  return FUNCTION_URL_HOST.exec(url.hostname)?.[1];
}

export function sigV4Signer(options: SigV4SignerOptions = {}): RequestSigner {
  const credentials = options.credentials ?? defaultProvider();
  const signers = new Map<string, SignatureV4>();
  return async ({ method, url, headers, body }) => {
    const region = options.region ?? functionUrlRegion(url);
    if (region === undefined) throw new RangeError("cannot tell the region of the Function URL");
    let signer = signers.get(region);
    if (signer === undefined) {
      signer = new SignatureV4({ service: "lambda", region, credentials, sha256: Sha256 });
      signers.set(region, signer);
    }
    const request: HttpRequestToSign = {
      method: method.toUpperCase(),
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...headers, host: url.host },
      ...(body === undefined ? {} : { body }),
    };
    const signed = await signer.sign(request, options.signingDate === undefined ? undefined : { signingDate: options.signingDate() });
    return { ...signed.headers };
  };
}
