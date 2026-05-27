"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { QrCode, X, Download, Copy, Check } from "lucide-react";
import { SITE_URL } from "@/lib/config";

type QRCodeButtonProps = {
  username: string;
};

export function QRCodeButton({ username }: QRCodeButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const qrRef = useRef<HTMLDivElement>(null);
  const profileUrl = `${typeof window !== "undefined" ? window.location.origin : SITE_URL}/profile/${username}`;

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  const handleDownload = useCallback(() => {
    const svgEl = qrRef.current?.querySelector("svg");
    if (!svgEl) return;

    const svgData = new XMLSerializer().serializeToString(svgEl);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const pngUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.download = `novasupport-${username}-qr.png`;
      link.href = pngUrl;
      link.click();
    };
    img.src = `data:image/svg+xml;base64,${btoa(svgData)}`;
  }, [username]);

  const handleCopyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = profileUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [profileUrl]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Show QR code"
        className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-sky/80 transition hover:bg-white/10 hover:text-white"
      >
        <QrCode size={14} />
        QR Code
      </button>

      {open && (
        <>
          {/* Backdrop for mobile */}
          <div
            className="fixed inset-0 z-40 bg-black/60 sm:hidden"
            onClick={() => setOpen(false)}
          />
          <div
            ref={popoverRef}
            role="dialog"
            aria-modal="true"
            aria-label="Profile QR code"
            className="absolute left-1/2 top-full z-50 mt-2 w-[260px] -translate-x-1/2 rounded-2xl border border-white/10 bg-[#0A0A0B] p-5 shadow-2xl sm:left-0 sm:translate-x-0"
          >
            <div className="mb-3 flex items-center justify-between gap-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-steel">
                Scan to support
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close QR code"
                className="rounded-lg p-1 text-steel transition hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
            <div ref={qrRef} className="flex justify-center rounded-xl bg-white p-3">
              <QRCodeSVG value={profileUrl} size={180} />
            </div>
            <p className="mt-3 break-all text-center text-[10px] text-steel">
              {profileUrl}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={handleDownload}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/10"
              >
                <Download size={12} />
                Download
              </button>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/10"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy URL"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
