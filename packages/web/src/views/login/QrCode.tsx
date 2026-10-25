// QR code of the otpauth URI, drawn here as SVG from lean-qr's module matrix: the TOTP secret is
// never sent to a QR service or any other third party.
import { generate } from "lean-qr";
import { useMemo } from "react";

const QUIET_ZONE = 4;

export function QrCode({ value, label }: { readonly value: string; readonly label: string }) {
  const { size, path } = useMemo(() => {
    const code = generate(value);
    const commands: string[] = [];
    for (let y = 0; y < code.size; y += 1) {
      for (let x = 0; x < code.size; x += 1) {
        if (code.get(x, y)) commands.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
      }
    }
    return { size: code.size + QUIET_ZONE * 2, path: commands.join("") };
  }, [value]);

  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className="h-44 w-44 shrink-0 rounded-md bg-white text-pine-deep">
      <path d={path} fill="currentColor" />
    </svg>
  );
}
