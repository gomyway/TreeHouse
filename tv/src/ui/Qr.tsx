import QRCode from "qrcode";
import { useEffect, useState } from "react";

// Renders a QR code as an inline SVG. Dark modules on a light tile so phones scan it
// reliably from across the room, whatever the TV's picture settings.
export function Qr({ value, size }: { value: string; size: number }) {
  const [svg, setSvg] = useState("");

  useEffect(() => {
    let live = true;
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(""));
    return () => {
      live = false;
    };
  }, [value]);

  return (
    <div
      className="qr"
      style={{ width: size, height: size }}
      aria-label={`QR code for ${value}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
