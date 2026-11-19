"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { AppShell } from "@/components/app-shell";
import { Toast } from "@/components/toast";
import { EmptyState } from "@/components/empty-state";
import { apiFetch } from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/config";

interface RecurringSupport {
  id: string;
  profileId: string;
  profileUsername: string;
  profileDisplayName: string;
  profileAvatarUrl: string | null;
  amount: string;
  assetCode: string;
  frequency: string;
  nextRunAt: string;
  status: "active" | "paused" | "cancelled";
  createdAt: string;
}

type ActionTarget = { id: string; action: "cancel" | "pause" | "resume" };

function StatusBadge({ status }: { status: RecurringSupport["status"] }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
        Active
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="inline-flex items-center rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-yellow-400">
        Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
      {status}
    </span>
  );
}

export default function RecurringPage() {
  const router = useRouter();
  const [subscriptions, setSubscriptions] = useState<RecurringSupport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  useEffect(() => {
    async function loadRecurringSupport() {
      try {
        const meRes = await apiFetch(`${API_BASE_URL}/auth/me`, {
          suppressAuthExpired: true,
        } as RequestInit & { suppressAuthExpired?: boolean });
        if (!meRes.ok) {
          router.push("/");
          return;
        }

        const me = await meRes.json();
        const username = typeof me?.username === "string" ? me.username : null;
        if (!username) {
          router.push("/");
          return;
        }

        const res = await apiFetch(`${API_BASE_URL}/v1/recurring-support`);
        if (!res.ok)
          throw new Error("Failed to load recurring support subscriptions");
        const data = await res.json();
        setSubscriptions(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setLoading(false);
      }
    }

    loadRecurringSupport();
  }, [router]);

  async function handleCancel(id: string) {
    setProcessing(id);
    try {
      const res = await apiFetch(`${API_BASE_URL}/v1/recurring-support/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to cancel subscription");
      // Remove cancelled subscription from list
      setSubscriptions((prev) => prev.filter((s) => s.id !== id));
      setToast({ message: "Subscription cancelled", type: "success" });
    } catch (err: unknown) {
      setToast({
        message:
          err instanceof Error ? err.message : "Failed to cancel subscription",
        type: "error",
      });
    } finally {
      setProcessing(null);
      setActionTarget(null);
    }
  }

  async function handlePatch(id: string, status: "paused" | "active") {
    setProcessing(id);
    try {
      const res = await apiFetch(`${API_BASE_URL}/v1/recurring-support/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok)
        throw new Error(
          `Failed to ${status === "paused" ? "pause" : "resume"} subscription`,
        );
      setSubscriptions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status } : s)),
      );
      setToast({
        message:
          status === "paused" ? "Subscription paused" : "Subscription resumed",
        type: "success",
      });
    } catch (err: unknown) {
      setToast({
        message: err instanceof Error ? err.message : "Action failed",
        type: "error",
      });
    } finally {
      setProcessing(null);
      setActionTarget(null);
    }
  }

  // Split into active, paused and cancelled groups for clear visual separation
  const activeSubscriptions = subscriptions.filter(
    (s) => s.status === "active",
  );
  const pausedSubscriptions = subscriptions.filter(
    (s) => s.status === "paused",
  );
  const cancelledSubscriptions = subscriptions.filter(
    (s) => s.status === "cancelled",
  );

  function renderConfirmBar(sub: RecurringSupport) {
    if (!actionTarget || actionTarget.id !== sub.id) return null;

    const { action } = actionTarget;

    const labelMap = {
      cancel: {
        question: "Cancel this drip?",
        confirm: "Yes, cancel",
        confirming: "Cancelling…",
      },
      pause: {
        question: "Pause this drip?",
        confirm: "Yes, pause",
        confirming: "Pausing…",
      },
      resume: {
        question: "Resume this drip?",
        confirm: "Yes, resume",
        confirming: "Resuming…",
      },
    };
    const labels = labelMap[action];
    const isProcessing = processing === sub.id;

    return (
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-xs text-white/50">{labels.question}</span>
        <button
          onClick={() => {
            if (action === "cancel") handleCancel(sub.id);
            else if (action === "pause") handlePatch(sub.id, "paused");
            else handlePatch(sub.id, "active");
          }}
          disabled={isProcessing}
          className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/30 disabled:opacity-50"
        >
          {isProcessing ? labels.confirming : labels.confirm}
        </button>
        <button
          onClick={() => setActionTarget(null)}
          className="rounded-lg px-3 py-1.5 text-xs text-white/50 hover:text-white"
        >
          Keep it
        </button>
      </div>
    );
  }

  function renderActions(sub: RecurringSupport) {
    // Cancelled subscriptions are history only; nothing left to act on.
    if (sub.status === "cancelled") return null;
    if (actionTarget?.id === sub.id) return renderConfirmBar(sub);

    // Disable buttons whenever this subscription's action is in flight,
    // regardless of which subscription's confirm bar is currently open.
    const isProcessing = processing === sub.id;

    return (
      <div className="flex items-center gap-2 flex-shrink-0">
        {sub.status === "active" ? (
          <button
            onClick={() => setActionTarget({ id: sub.id, action: "pause" })}
            disabled={isProcessing}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:border-yellow-400/40 hover:text-yellow-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Pause
          </button>
        ) : (
          <button
            onClick={() => setActionTarget({ id: sub.id, action: "resume" })}
            disabled={isProcessing}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:border-emerald-400/40 hover:text-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Resume
          </button>
        )}
        <button
          onClick={() => setActionTarget({ id: sub.id, action: "cancel" })}
          disabled={isProcessing}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:border-red-400/40 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>
    );
  }

  function renderSubscriptionCard(sub: RecurringSupport) {
    return (
      <li
        key={sub.id}
        className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/5 p-4"
      >
        <div className="flex items-center gap-3 min-w-0">
          {sub.profileAvatarUrl ? (
            <Image
              src={sub.profileAvatarUrl}
              alt={sub.profileDisplayName}
              width={40}
              height={40}
              className="h-10 w-10 rounded-full object-cover flex-shrink-0"
            />
          ) : (
            <div className="h-10 w-10 rounded-full bg-white/10 flex items-center justify-center text-sm text-white/60 flex-shrink-0">
              {sub.profileDisplayName?.[0]?.toUpperCase() ?? "?"}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-white truncate">
                {sub.profileDisplayName}
              </p>
              <StatusBadge status={sub.status} />
            </div>
            <p className="text-xs text-white/40">
              {sub.amount} {sub.assetCode} · {sub.frequency}
              {sub.status !== "cancelled" && (
                <> · next {new Date(sub.nextRunAt).toLocaleDateString()}</>
              )}
            </p>
          </div>
        </div>

        {renderActions(sub)}
      </li>
    );
  }

  const hasAny = subscriptions.length > 0;

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-white mb-1">
          Recurring support
        </h1>
        <p className="text-sm text-white/50 mb-8">
          Manage the creators you support on a recurring basis.
        </p>

        {loading && <p className="text-sm text-white/40">Loading…</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        {!loading && !error && !hasAny && (
          <EmptyState
            title="No recurring support yet"
            description="When you set up a recurring drip to a creator, it will show up here."
          />
        )}

        {!loading && hasAny && (
          <div className="space-y-8">
            {activeSubscriptions.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-widest text-white/40 mb-3">
                  Active ({activeSubscriptions.length})
                </h2>
                <ul className="space-y-3">
                  {activeSubscriptions.map(renderSubscriptionCard)}
                </ul>
              </section>
            )}

            {pausedSubscriptions.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-widest text-white/40 mb-3">
                  Paused ({pausedSubscriptions.length})
                </h2>
                <ul className="space-y-3">
                  {pausedSubscriptions.map(renderSubscriptionCard)}
                </ul>
              </section>
            )}

            {cancelledSubscriptions.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-widest text-white/40 mb-3">
                  Cancelled ({cancelledSubscriptions.length})
                </h2>
                <ul className="space-y-3">
                  {cancelledSubscriptions.map(renderSubscriptionCard)}
                </ul>
              </section>
            )}
          </div>
        )}
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
