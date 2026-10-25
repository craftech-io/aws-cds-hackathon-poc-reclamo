// Links between the operation views: a complaint at `/app/complaints/:id`, a customer at
// `/app/customers/:id`. The id is read from the path and checked with the BFF's own id schemas
// before it travels; anything else is "no such complaint" in the view, never a request.
import { CustomerId, Id } from "@reclamo/shared";
import { matchPath } from "../../lib/router";
import { CONSOLE_PREFIX } from "../../routes";

const COMPLAINT_PATTERN = `${CONSOLE_PREFIX}/complaints/:id`;
const CUSTOMER_PATTERN = `${CONSOLE_PREFIX}/customers/:id`;

export function complaintPath(complaintId: string): string {
  return `${CONSOLE_PREFIX}/complaints/${encodeURIComponent(complaintId)}`;
}

export function customerPath(customerId: string): string {
  return `${CONSOLE_PREFIX}/customers/${encodeURIComponent(customerId)}`;
}

/** The complaint id of `/app/complaints/:id`, or undefined when the path does not carry a valid one. */
export function complaintIdOf(path: string): string | undefined {
  const parsed = Id.safeParse(matchPath(COMPLAINT_PATTERN, path)?.["id"]);
  return parsed.success ? parsed.data : undefined;
}

/** The customer id of `/app/customers/:id`, or undefined when the path does not carry a valid one. */
export function customerIdOf(path: string): string | undefined {
  const parsed = CustomerId.safeParse(matchPath(CUSTOMER_PATTERN, path)?.["id"]);
  return parsed.success ? parsed.data : undefined;
}
