// Files the console hands the viewer: a PDF of a presigned link is fetched (timeout and retry) into a
// `blob:` URL, never opened by its S3 URL (docs/architecture.md §11); text the BFF answered (a CSV of
// the metrics) becomes a blob as well. Either way the browser saves it under a name chosen by code.
import { fetchWithRetry } from "../../lib/http";

const DOWNLOAD_TIMEOUT_MS = 20_000;

/** Saves a blob under `filename` through a temporary `blob:` link, released right after. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Fetches a presigned GET and checks the type the code fixed for it before saving it. */
export async function downloadPresigned(url: string, contentType: string, filename: string): Promise<void> {
  const response = await fetchWithRetry(url, { credentials: "omit" }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  const blob = await response.blob();
  saveBlob(new Blob([blob], { type: contentType }), filename);
}

/** Saves text the BFF answered (an escaped CSV) as a file. */
export function saveText(text: string, contentType: string, filename: string): void {
  saveBlob(new Blob([text], { type: contentType }), filename);
}
