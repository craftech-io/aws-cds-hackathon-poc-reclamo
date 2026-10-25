import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ComponentMeta,
  type ContractDocument,
  ErrorBody,
  WorldHeaders,
  WorldParams,
  coreContract,
  defineRoute,
  networksContract,
} from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { CONTRACT_DIR, type Difference, checkContract, checkDocument, checkMirrors, diffJson, normalize } from "./contract-check";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const coreYaml = readFileSync(resolve(REPO_ROOT, CONTRACT_DIR, coreContract.file), "utf8");
const networksYaml = readFileSync(resolve(REPO_ROOT, CONTRACT_DIR, networksContract.file), "utf8");

// A parsed YAML document under mutation.
type Doc = Record<string, any>;

/** The core YAML after `mutate`, checked against the real zod side. */
function coreWith(mutate: (doc: Doc) => void): Difference[] {
  const doc = parse(coreYaml) as Doc;
  mutate(doc);
  return checkDocument(coreContract, stringify(doc));
}

const at = (differences: readonly Difference[]) => differences.map((difference) => difference.at);
const messages = (differences: readonly Difference[]) => differences.map((difference) => `${difference.at}: ${difference.message}`).join("\n");

describe("the committed contract", () => {
  it("core.openapi.yaml and networks.openapi.yaml match their zod schemas", () => {
    const differences = checkContract(REPO_ROOT);
    expect(messages(differences)).toBe("");
  });

  it("each document is checked on its own", () => {
    expect(checkDocument(coreContract, coreYaml)).toEqual([]);
    expect(checkDocument(networksContract, networksYaml)).toEqual([]);
  });

  it("checks one document against the other's YAML and finds the difference", () => {
    const differences = checkDocument(networksContract, coreYaml);
    expect(differences.length).toBeGreaterThan(0);
    expect(messages(differences)).toContain("operation registerCollection in zod only");
  });

  it("PaymentNetwork mirrors Network of @reclamo/shared", () => {
    expect(checkMirrors()).toEqual([]);
  });
});

describe("components", () => {
  it("reports a changed keyword with its pointer", () => {
    const differences = coreWith((doc) => {
      doc.components.schemas.WorldId.pattern = "^[a-z0-9-]{1,48}$";
    });
    expect(at(differences)).toEqual(["#/components/schemas/WorldId/pattern"]);
    expect(differences[0]?.message).toContain('zod "^[a-z0-9-]{1,24}$"');
  });

  it("reports an object that stops being closed", () => {
    const differences = coreWith((doc) => {
      delete doc.components.schemas.Customer.additionalProperties;
    });
    expect(at(differences)).toEqual(["#/components/schemas/Customer/additionalProperties"]);
  });

  it("reports a field the YAML adds, drops or makes optional", () => {
    const added = coreWith((doc) => {
      doc.components.schemas.Customer.properties.liveE164 = { type: "string" };
    });
    expect(at(added)).toEqual(["#/components/schemas/Customer/properties/liveE164"]);

    const dropped = coreWith((doc) => {
      delete doc.components.schemas.PaymentRequest.properties.cap;
      doc.components.schemas.PaymentRequest.required = doc.components.schemas.PaymentRequest.required.filter((name: string) => name !== "cap");
    });
    expect(at(dropped)).toContain("#/components/schemas/PaymentRequest/properties/cap");

    const optional = coreWith((doc) => {
      doc.components.schemas.PaymentRequest.required = doc.components.schemas.PaymentRequest.required.filter((name: string) => name !== "customerId");
    });
    expect(at(optional)).toEqual(["#/components/schemas/PaymentRequest/required"]);
  });

  it("reports a component missing on either side", () => {
    const missing = coreWith((doc) => {
      delete doc.components.schemas.Disbursement;
    });
    expect(missing).toContainEqual(expect.objectContaining({ at: "#/components/schemas/Disbursement", message: "component in zod only" }));

    const extra = coreWith((doc) => {
      doc.components.schemas.Unused = { type: "string" };
    });
    expect(extra).toContainEqual(expect.objectContaining({ at: "#/components/schemas/Unused", message: "component in the YAML only" }));
  });

  it("ignores annotations and the order of enums and required", () => {
    const differences = coreWith((doc) => {
      const status = doc.components.schemas.LoanStatus;
      status.enum = [...status.enum].reverse();
      status.description = "reworded";
      status.examples = ["ACTIVE"];
      status["x-note"] = "vendor extension";
      doc.components.schemas.Loan.required.reverse();
    });
    expect(differences).toEqual([]);
  });

  it("reports a changed enum value", () => {
    const differences = coreWith((doc) => {
      doc.components.schemas.ChallengeKind.enum = ["LAST_DUE_DATE", "LAST_INSTALMENT_AMOUNT", "LAST_PASSWORD"];
    });
    expect(at(differences)).toEqual(["#/components/schemas/ChallengeKind/enum"]);
    expect(differences[0]?.message).toContain('"LAST_PASSWORD"');
  });
});

describe("operations", () => {
  const payments = "#/paths/~1v1~1{worldId}~1loans~1{loanId}~1payments/post";

  it("reports an operation missing on either side", () => {
    const missing = coreWith((doc) => {
      delete doc.paths["/v1/{worldId}/refunds"];
    });
    expect(messages(missing)).toContain("operation refundDuplicateDebit in zod only");

    const extra = coreWith((doc) => {
      doc.paths["/v1/{worldId}/loans/{loanId}/payments"].delete = doc.paths["/v1/{worldId}/loans/{loanId}/payments"].post;
    });
    expect(extra).toContainEqual(expect.objectContaining({ message: "operation in the YAML only" }));
  });

  it("reports a renamed operationId", () => {
    const differences = coreWith((doc) => {
      doc.paths["/v1/{worldId}/loans/{loanId}/payments"].post.operationId = "imputePayment";
    });
    expect(at(differences)).toEqual([`${payments}/operationId`]);
  });

  it("reports a response status missing, added or answering another schema", () => {
    const missing = coreWith((doc) => {
      delete doc.paths["/v1/{worldId}/loans/{loanId}/payments"].post.responses["409"];
    });
    expect(missing).toContainEqual(expect.objectContaining({ at: `${payments}/responses/409`, message: "status in zod only" }));

    const added = coreWith((doc) => {
      doc.paths["/v1/{worldId}/loans/{loanId}"].get.responses["409"] = { $ref: "#/components/responses/Conflict" };
    });
    expect(added).toContainEqual(expect.objectContaining({ message: "status in the YAML only" }));

    const other = coreWith((doc) => {
      doc.paths["/v1/{worldId}/loans/{loanId}/payments"].post.responses["200"].content["application/json"].schema = { $ref: "#/components/schemas/Loan" };
    });
    expect(at(other)).toEqual([`${payments}/responses/200/content/application~1json/schema/$ref`]);
  });

  it("reports a response that is not JSON", () => {
    const differences = coreWith((doc) => {
      const ok = doc.paths["/v1/{worldId}/loans/{loanId}"].get.responses["200"];
      ok.content = { "application/xml": ok.content["application/json"] };
    });
    expect(messages(differences)).toContain("content must be exactly application/json");
  });

  it("reports a request body missing, extra, optional or of another schema", () => {
    const missing = coreWith((doc) => {
      delete doc.paths["/v1/{worldId}/loans/{loanId}/payments"].post.requestBody;
    });
    expect(missing).toContainEqual(expect.objectContaining({ at: `${payments}/requestBody`, message: "request body in zod only" }));

    const extra = coreWith((doc) => {
      doc.paths["/v1/{worldId}/charges/{chargeId}/check"].post.requestBody = { required: true, content: { "application/json": { schema: { type: "object" } } } };
    });
    expect(extra).toContainEqual(expect.objectContaining({ message: "request body in the YAML only" }));

    const optional = coreWith((doc) => {
      doc.paths["/v1/{worldId}/loans/{loanId}/payments"].post.requestBody.required = false;
    });
    expect(at(optional)).toEqual([`${payments}/requestBody/required`]);

    const other = coreWith((doc) => {
      doc.paths["/v1/{worldId}/loans/{loanId}/payments"].post.requestBody.content["application/json"].schema = { $ref: "#/components/schemas/RefundRequest" };
    });
    expect(at(other)).toEqual([`${payments}/requestBody/schema/$ref`]);
  });

  it("reports parameters: required flag, schema, missing and extra", () => {
    const operations = "#/paths/~1v1~1{worldId}~1customers~1{customerId}~1operations/get";
    const optional = coreWith((doc) => {
      const from = doc.paths["/v1/{worldId}/customers/{customerId}/operations"].get.parameters.find((p: Doc) => p.name === "from");
      from.required = false;
    });
    expect(at(optional)).toEqual([`${operations}/parameters(query:from)/required`]);

    const schema = coreWith((doc) => {
      doc.components.parameters.LoanIdPath.schema = { $ref: "#/components/schemas/ResourceId" };
    });
    expect(at(schema).length).toBeGreaterThan(0);
    expect(at(schema).every((pointer) => pointer.endsWith("parameters(path:loanId)/schema/$ref"))).toBe(true);

    const noHeader = coreWith((doc) => {
      const get = doc.paths["/v1/{worldId}/loans/{loanId}"].get;
      get.parameters = get.parameters.filter((p: Doc) => p.$ref !== "#/components/parameters/SimNow");
    });
    expect(noHeader).toContainEqual(expect.objectContaining({ message: "parameter in zod only" }));
    expect(at(noHeader)[0]).toContain("parameters(header:x-sim-now)");

    const extra = coreWith((doc) => {
      doc.paths["/v1/{worldId}/loans/{loanId}"].get.parameters.push({ name: "expand", in: "query", schema: { type: "string" } });
    });
    expect(extra).toContainEqual(expect.objectContaining({ message: "parameter in the YAML only" }));
  });

  it("compares header names without case", () => {
    const differences = coreWith((doc) => {
      doc.components.parameters.SimNow.name = "x-sim-now";
    });
    expect(differences).toEqual([]);
  });
});

describe("the document", () => {
  it("must be OpenAPI 3.1 with the contract version", () => {
    const differences = coreWith((doc) => {
      doc.openapi = "3.0.3";
      doc.info.version = "0.9.0";
    });
    expect(at(differences)).toEqual(["#/openapi", "#/info/version"]);
  });

  it("reports text that is not YAML or not a document", () => {
    expect(checkDocument(coreContract, "openapi: [3.1\n")[0]?.message).toMatch(/^not valid YAML/);
    expect(checkDocument(coreContract, "just text")[0]?.message).toBe("not an OpenAPI document");
  });
});

describe("rules of the zod side", () => {
  // A small contract with its own registry, so broken zod never touches the real registries.
  function fixture(build: (component: <T extends z.ZodType>(id: string, schema: T) => T) => ContractDocument["routes"]): { doc: ContractDocument; yaml: string } {
    const registry = z.registry<ComponentMeta>();
    const component = <T extends z.ZodType>(id: string, schema: T): T => {
      registry.add(schema, { id });
      return schema;
    };
    for (const schema of [ErrorBody, WorldParams.shape.worldId, WorldHeaders.shape["x-sim-now"], WorldHeaders.shape["x-correlation-id"].unwrap()]) {
      const id = coreContract.registry.get(schema)?.id;
      if (id) component(id, schema);
    }
    const routes = build(component);
    const doc: ContractDocument = { file: "fixture.openapi.yaml", registry, routes };
    return { doc, yaml: stringify({ openapi: "3.1.1", info: { version: "1.0.0" }, paths: {}, components: { schemas: {} } }) };
  }

  it("rejects a refinement, which the YAML cannot state", () => {
    const { doc, yaml } = fixture((component) => {
      component("Even", z.number().int().refine((value) => value % 2 === 0));
      return {};
    });
    expect(messages(checkDocument(doc, yaml))).toContain("Even: a zod refinement or transform has no OpenAPI form");
  });

  it("rejects a route whose placeholders and params differ, and a world route without X-Sim-Now", () => {
    const { doc, yaml } = fixture((component) => {
      const Thing = component("Thing", z.object({ id: z.string() }).strict());
      return {
        getThing: defineRoute({ method: "get", path: "/v1/{worldId}/things/{thingId}", params: WorldParams, ok: Thing, errors: [] }),
      };
    });
    const found = messages(checkDocument(doc, yaml));
    expect(found).toContain("getThing: path /v1/{worldId}/things/{thingId} has {thingId, worldId} but params {worldId}");
    expect(found).toContain("getThing: a world route must require the x-sim-now header");
  });

  it("rejects a body, response or parameter whose schema is not a component", () => {
    const { doc, yaml } = fixture(() => ({
      postThing: defineRoute({
        method: "post",
        path: "/v1/{worldId}/things",
        params: WorldParams,
        headers: WorldHeaders,
        body: z.object({ id: z.string() }).strict(),
        ok: z.object({ id: z.string() }).strict(),
        errors: [400],
      }),
    }));
    const doc2: Doc = parse(yaml);
    doc2.paths["/v1/{worldId}/things"] = {
      post: {
        operationId: "postThing",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } }, "400": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    };
    const found = messages(checkDocument(doc, stringify(doc2)));
    expect(found).toContain("postThing request body: its schema is not a registered component of fixture.openapi.yaml");
    expect(found).toContain("postThing 200: its schema is not a registered component of fixture.openapi.yaml");
  });
});

describe("normalize and diffJson", () => {
  it("drops annotations and sorts set-like keywords", () => {
    expect(normalize({ description: "x", "x-a": 1, $schema: "s", $id: "i", type: ["null", "string"], required: ["b", "a"], enum: ["Z", "A"], properties: { a: { title: "t", type: "string" } } })).toEqual({
      enum: ["A", "Z"],
      properties: { a: { type: "string" } },
      required: ["a", "b"],
      type: ["null", "string"],
    });
  });

  it("points at every difference and escapes pointer tokens", () => {
    expect(diffJson({ a: 1, "b/c": [1, 2] }, { a: 2, "b/c": [1, 3] }, "#")).toEqual([
      ["#/a", "zod 1 · yaml 2"],
      ["#/b~1c/1", "zod 2 · yaml 3"],
    ]);
    expect(diffJson({ a: 1 }, {}, "#")).toEqual([["#/a", "zod 1 · yaml (absent)"]]);
    expect(diffJson([1], [1, 2], "#")).toEqual([["#", "zod [1] · yaml [1,2]"]]);
  });
});
