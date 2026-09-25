"use client";

import { useEffect, useState, useCallback } from "react";
import { Check } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/config";

type Prefs = {
  notifyOnSupport: boolean;
  notifyOnMilestone: boolean;
  weeklyDigest: boolean;
};

type Props = {
  username: string;
};

export function NotificationPreferences({ username }: Props) {
  const [prefs, setPrefs] = useState<Prefs>({
    notifyOnSupport: true,
    notifyOnMilestone: true,
    weeklyDigest: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch(`${API_BASE_URL}/profiles/${username}/notification-preferences`),
      apiFetch(`${API_BASE_URL}/profiles/${username}`),
    ])
      .then(([prefsRes, profileRes]) =>
        Promise.all([
          prefsRes.ok ? prefsRes.json() : null,
          profileRes.ok ? profileRes.json() : null,
        ]),
      )
      .then(([prefsData, profileData]) => {
        if (prefsData) setPrefs(prefsData);
        if (profileData) setEmailVerified(profileData.emailVerified ?? false);
      })
      .catch(() => {
        setError("Failed to load notification preferences");
      })
      .finally(() => setLoading(false));
  }, [username]);

  const handleToggle = useCallback(
    async (key: keyof Prefs) => {
      const newValue = !prefs[key];
      setPrefs((prev) => ({ ...prev, [key]: newValue }));
      setSaving(key);
      setError(null);

      try {
        const res = await apiFetch(
          `${API_BASE_URL}/profiles/${username}/notification-preferences`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [key]: newValue }),
          },
        );

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Failed to save preference");
        }

        setSaved((prev) => ({ ...prev, [key]: true }));
        setTimeout(
          () => setSaved((prev) => ({ ...prev, [key]: false })),
          2000,
        );
      } catch (err: unknown) {
        setPrefs((prev) => ({ ...prev, [key]: !newValue }));
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setSaving(null);
      }
    },
    [prefs, username],
  );

  if (loading) {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4">
        <div className="h-4 w-48 rounded bg-white/10 animate-pulse" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
              <div className="space-y-1.5">
                <div className="h-3.5 w-32 rounded bg-white/10 animate-pulse" />
                <div className="h-2.5 w-56 rounded bg-white/5 animate-pulse" />
              </div>
              <div className="h-5 w-9 rounded-full bg-white/10 animate-pulse" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const toggleClass = (on: boolean) =>
    `relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
      on ? "bg-[#00e5b0]" : "bg-white/10"
    }`;

  const knobClass = (on: boolean) =>
    `pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition duration-200 ${
      on ? "translate-x-4" : "translate-x-0"
    }`;

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-white/60">
        Notification Preferences
      </h2>

      <div className="space-y-3">
        <PreferenceRow
          label="New support received"
          description="Get an email when someone sends you support."
          checked={prefs.notifyOnSupport}
          saving={saving === "notifyOnSupport"}
          saved={!!saved.notifyOnSupport}
          onToggle={() => handleToggle("notifyOnSupport")}
          toggleClass={toggleClass}
          knobClass={knobClass}
        />
        <PreferenceRow
          label="Milestone reached"
          description="Notify me when one of my funding goals is reached."
          checked={prefs.notifyOnMilestone}
          saving={saving === "notifyOnMilestone"}
          saved={!!saved.notifyOnMilestone}
          onToggle={() => handleToggle("notifyOnMilestone")}
          toggleClass={toggleClass}
          knobClass={knobClass}
        />
        <PreferenceRow
          label="Weekly digest"
          description="Send me a weekly summary of my support activity."
          checked={prefs.weeklyDigest}
          saving={saving === "weeklyDigest"}
          saved={!!saved.weeklyDigest}
          onToggle={() => handleToggle("weeklyDigest")}
          toggleClass={toggleClass}
          knobClass={knobClass}
        />
      </div>

      {emailVerified === false && (
        <p className="text-xs text-amber-400">
          Verify your email to receive notifications
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}

function PreferenceRow({
  label,
  description,
  checked,
  saving,
  saved,
  onToggle,
  toggleClass,
  knobClass,
}: {
  label: string;
  description: string;
  checked: boolean;
  saving: boolean;
  saved: boolean;
  onToggle: () => void;
  toggleClass: (on: boolean) => string;
  knobClass: (on: boolean) => string;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 cursor-pointer">
      <span className="min-w-0 block">
        <span className="text-sm font-medium text-white block">{label}</span>
        <span className="text-xs text-white/40 mt-0.5 block">{description}</span>
      </span>
      <span className="flex items-center gap-2 flex-shrink-0">
        {saved && (
          <span className="flex items-center gap-0.5 text-[10px] text-mint">
            <Check size={10} />
            Saved
          </span>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={onToggle}
          disabled={saving}
          className={toggleClass(checked)}
        >
          <span className={knobClass(checked)} />
        </button>
      </span>
    </label>
  );
}
