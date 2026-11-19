"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Toast } from "@/components/toast";
import { NotificationPreferences } from "@/components/notification-preferences";
import { apiFetch } from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/config";

export default function SettingsPage() {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [resending, setResending] = useState(false);
  const [deleteStep, setDeleteStep] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  useEffect(() => {
    async function loadCurrentUser() {
      try {
        const meRes = await apiFetch(`${API_BASE_URL}/auth/me`, {
          suppressAuthExpired: true,
        } as RequestInit & { suppressAuthExpired?: boolean });
        if (!meRes.ok) {
          router.push("/");
          return;
        }

        const me = await meRes.json();
        const resolvedUsername =
          typeof me?.username === "string" ? me.username : null;
        if (!resolvedUsername) {
          router.push("/");
          return;
        }

        setUsername(resolvedUsername);

        const profileRes = await apiFetch(
          `${API_BASE_URL}/profiles/${resolvedUsername}`,
        );
        if (profileRes.ok) {
          const data = await profileRes.json();
          setEmailVerified(Boolean(data.emailVerified));
        }
      } catch {
        router.push("/");
      } finally {
        setLoading(false);
      }
    }

    loadCurrentUser();
  }, [router]);

  async function handleResendVerification() {
    if (!username) return;
    setResending(true);
    try {
      const res = await apiFetch(
        `${API_BASE_URL}/profiles/${username}/resend-verification-email`,
        {
          method: "POST",
        },
      );
      setToast(
        res.ok
          ? {
              message: "Verification email sent — check your inbox",
              type: "success",
            }
          : { message: "Failed to resend verification email", type: "error" },
      );
    } catch {
      setToast({
        message: "Failed to resend verification email",
        type: "error",
      });
    } finally {
      setResending(false);
    }
  }

  async function handleDeleteProfile() {
    if (!username) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/profiles/${username}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete profile");

      // Revoke the JWT server-side so it can't keep authenticating requests
      // as the now-deleted profile for the rest of its 1h expiry.
      await apiFetch(`${API_BASE_URL}/v1/auth/logout`, {
        method: "POST",
      }).catch(() => {});

      localStorage.removeItem("username");
      // Clear wallet-connect widget state so it doesn't auto-restore a
      // "connected" UI for a wallet whose profile no longer exists.
      localStorage.removeItem("walletAddress");
      localStorage.removeItem("walletId");
      router.push("/");
    } catch (err: unknown) {
      setToast({
        message:
          err instanceof Error ? err.message : "Failed to delete profile",
        type: "error",
      });
      setDeleting(false);
      setDeleteStep(0);
    }
  }

  if (loading || !username) {
    return (
      <AppShell>
        <div className="mx-auto max-w-2xl px-4 py-10">
          <p className="text-sm text-white/40">Loading…</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 py-10 space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-white mb-1">Settings</h1>
          <p className="text-sm text-white/50">
            Manage your account preferences.
          </p>
        </div>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-6 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-white/60">
            Email verification
          </h2>
          <div className="flex items-center justify-between">
            <span
              className={`text-sm ${emailVerified ? "text-mint" : "text-amber-400"}`}
            >
              {emailVerified ? "Verified" : "Not verified"}
            </span>
            {!emailVerified && (
              <button
                onClick={handleResendVerification}
                disabled={resending}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:border-mint/40 hover:text-mint"
              >
                {resending ? "Sending…" : "Resend verification email"}
              </button>
            )}
          </div>
        </section>

        <NotificationPreferences username={username} />

        <section className="rounded-2xl border border-red-500/20 bg-red-500/5 p-6 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-red-300">
            Danger zone
          </h2>
          <p className="text-xs text-white/50">
            Deleting your profile permanently removes it and all related data
            (transactions, milestones, webhooks). This cannot be undone.
          </p>

          {deleteStep === 0 && (
            <button
              onClick={() => setDeleteStep(1)}
              className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
            >
              Delete profile
            </button>
          )}

          {deleteStep === 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/60">Are you sure?</span>
              <button
                onClick={() => setDeleteStep(2)}
                className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/30"
              >
                Yes, continue
              </button>
              <button
                onClick={() => setDeleteStep(0)}
                className="rounded-lg px-3 py-1.5 text-xs text-white/50 hover:text-white"
              >
                Cancel
              </button>
            </div>
          )}

          {deleteStep === 2 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/60">
                This is permanent. Delete @{username}?
              </span>
              <button
                onClick={handleDeleteProfile}
                disabled={deleting}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600"
              >
                {deleting ? "Deleting…" : "Permanently delete"}
              </button>
              <button
                onClick={() => setDeleteStep(0)}
                className="rounded-lg px-3 py-1.5 text-xs text-white/50 hover:text-white"
              >
                Cancel
              </button>
            </div>
          )}
        </section>
      </div>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}
