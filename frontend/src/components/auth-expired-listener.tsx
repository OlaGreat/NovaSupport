"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// #826: apiFetch dispatches "auth:expired" instead of forcing a full page
// reload on 401, so in-progress form state elsewhere on the page survives.
// This listener shows a lightweight prompt and lets the user choose when to
// navigate to re-authenticate.
export function AuthExpiredListener() {
  const router = useRouter();
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const handleExpired = () => setExpired(true);
    window.addEventListener("auth:expired", handleExpired);
    return () => window.removeEventListener("auth:expired", handleExpired);
  }, []);

  if (!expired) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="auth-expired-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.6)",
      }}
    >
      <div
        style={{
          maxWidth: 360,
          borderRadius: 16,
          padding: 24,
          background: "#0a0a0f",
          border: "1px solid rgba(255,255,255,0.1)",
          color: "#fff",
        }}
      >
        <h2 id="auth-expired-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Session expired
        </h2>
        <p style={{ marginTop: 8, marginBottom: 16, fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
          Your session has expired. Any unsaved changes on this page were not submitted.
          Please log in again to continue.
        </p>
        <button
          type="button"
          onClick={() => {
            setExpired(false);
            router.replace("/");
          }}
          style={{
            width: "100%",
            padding: "10px 16px",
            borderRadius: 9999,
            border: "none",
            background: "#00e5b0",
            color: "#0a0a0f",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Log in again
        </button>
      </div>
    </div>
  );
}
