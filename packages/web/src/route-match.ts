// Which route owns a path: its own path or anything under it (`/app/complaints/cmp-0123`), on a
// segment boundary. Pure, so the role matrix is unit-tested without React.
import { ROUTES, type ConsoleRoute } from "./routes";

export function routeOf(path: string): ConsoleRoute | undefined {
  return ROUTES.find((route) => path === route.path || path.startsWith(`${route.path}/`));
}
