"use client";

import { useEffect, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import { X } from "lucide-react";

type QRModalProps = {
  url: string;
  onClose: () => void;
};

export function QRModal({ url, onClose }: QRModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="relative rounded-3xl border border-white/10 bg-ink p-8 shadow-2xl flex flex-col items-center gap-4">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-1 text-steel hover:text-white transition"
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <QRCodeSVG value={url} size={200} bgColor="#0A0A0B" fgColor="#FFFFFF" />
        <p className="text-sm font-semibold text-white">Scan to support</p>
        <p className="text-xs text-steel break-all max-w-[200px] text-center">{url}</p>
      </div>
    </div>
  );
}
