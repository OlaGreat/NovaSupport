"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE_URL } from "@/lib/config";
import { AppShell } from "@/components/app-shell";
import { useToast } from "@/lib/use-toast";
import { Toast } from "@/components/toast";
import { validateWalletAddress } from "@/lib/stellar";
import { STELLAR_NETWORK } from "@/lib/config";

interface FormData {
  username: string;
  displayName: string;
  bio: string;
  walletAddress: string;
  acceptedAssets: string[];
  twitterHandle: string;
  githubHandle: string;
  websiteUrl: string;
  email: string;
}

type BackendField = "username" | "email";

function formatRateLimitMessage(minutes: number): string {
  return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

const CONSTRAINTS = [
  { field: "Username", rule: "Alphanumeric + hyphens · max 32 chars" },
  { field: "Display name", rule: "Max 64 chars" },
  { field: "Bio", rule: "Optional · max 280 chars" },
  { field: "Wallet", rule: "Valid Stellar public key (G…)" },
  { field: "Email", rule: "Optional · valid email format" },
  { field: "Website", rule: "Optional · must start with https://" },
  { field: "Twitter", rule: "Optional · max 15 chars · no @ prefix" },
  { field: "GitHub", rule: "Optional · max 39 chars · hyphens allowed" },
];

// Well-known Stellar mainnet issuers for preset assets offered in onboarding.
// XLM is native and never has an issuer.
const KNOWN_ISSUERS: Record<string, string> = {
  USDC:
    STELLAR_NETWORK === "PUBLIC"
      ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3THOJ2E37CEGOEZWDSP"
      : "GBBD47IF6LWK7P7MDMSCR4XFM6KJLGMGR5E2Q3ZXZQ4KQQYT5R3332W",
};

export default function CreatePage() {
  const router = useRouter();
  const { toast, showToast, dismiss } = useToast();

  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>({
    username: "",
    displayName: "",
    bio: "",
    walletAddress: "",
    acceptedAssets: ["XLM"],
    twitterHandle: "",
    githubHandle: "",
    websiteUrl: "",
    email: "",
  });

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<BackendField, string | null>>({
    username: null,
    email: null,
  });
  const [loading, setLoading] = useState(false);
  const [rateLimitAttempts, setRateLimitAttempts] = useState(0);
  const [rateLimitRetryAt, setRateLimitRetryAt] = useState<number | null>(null);
  const [cooldownNow, setCooldownNow] = useState(Date.now());
  const [assets, setAssets] = useState<Array<{ code: string; issuer: string }>>([
    { code: "XLM", issuer: "" },
  ]);

  useEffect(() => {
    if (!rateLimitRetryAt) {
      return;
    }

    const interval = window.setInterval(() => {
      setCooldownNow(Date.now());
      if (Date.now() >= rateLimitRetryAt) {
        setRateLimitRetryAt(null);
        setError(null);
        setLoading(false);
        window.clearInterval(interval);
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [rateLimitRetryAt]);

  const rateLimitRemainingMinutes =
    rateLimitRetryAt && rateLimitRetryAt > cooldownNow
      ? Math.max(1, Math.ceil((rateLimitRetryAt - cooldownNow) / 60000))
      : 0;
  const rateLimited = rateLimitRemainingMinutes > 0;
  const usernameFieldError =
    fieldErrors.username ??
    (form.username && !/^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?$/.test(form.username)
      ? "Username can only contain alphanumeric characters and hyphens, and must start and end with an alphanumeric character."
      : null);

  function set(field: keyof FormData) {
    return (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
    ) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      setError(null);
      if (field === "username" || field === "email") {
        setFieldErrors((prev) => ({ ...prev, [field]: null }));
      }
    };
  }

  const walletValidation = validateWalletAddress(form.walletAddress);
  const walletValid = form.walletAddress === "" || walletValidation.isValid;

  const twitterInvalid =
    form.twitterHandle !== "" &&
    !/^[a-zA-Z0-9_]+$/.test(form.twitterHandle);

  const githubInvalid =
    form.githubHandle !== "" &&
    !/^[a-zA-Z0-9\-]+$/.test(form.githubHandle);

  const websiteValid =
    form.websiteUrl === "" ||
    /^https:\/\/.+/.test(form.websiteUrl);

  const emailValid =
    form.email === "" ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email);

  const emailFieldError =
    fieldErrors.email ??
    (form.email && !emailValid ? "Enter a valid email address." : null);

  const handleNext = () => {
    if (step === 1) {
      if (!form.displayName.trim() || !form.username.trim()) {
        setError("Display name and username are required.");
        return;
      }
      if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?$/.test(form.username)) {
        setError("Username can only contain alphanumeric characters and hyphens, and must start and end with an alphanumeric character.");
        return;
      }
    }
    if (step === 2) {
      if (!form.walletAddress) {
        setError("Wallet address is required.");
        return;
      }
      if (!walletValidation.isValid) {
        setError(walletValidation.error || "Please enter a valid Stellar wallet address.");
        return;
      }
      if (assets.length === 0) {
        setError("Please select at least one accepted asset.");
        return;
      }
      const missingIssuer = assets.find((a) => a.code !== "XLM" && !a.issuer.trim());
      if (missingIssuer) {
        setError(`Issuer required for ${missingIssuer.code} — please enter the Stellar issuer address.`);
        return;
      }
    }
    if (step === 3) {
      if (twitterInvalid || githubInvalid || !websiteValid || !emailValid) {
        setError("Please fix the errors in your social links.");
        return;
      }
    }

    setError(null);
    setStep((s) => s + 1);
  };

  const handleBack = () => {
    setError(null);
    setStep((s) => s - 1);
  };

  async function handleSubmit() {
    if (loading) return;

    setError(null);
    setFieldErrors({ username: null, email: null });

    if (step < 3) {
      handleNext();
      return;
    }

    if (twitterInvalid || githubInvalid || !websiteValid || !emailValid) {
      setError("Please fix the errors in your social links.");
      return;
    }

    if (!walletValidation.isValid) {
      showToast(walletValidation.error || "Please enter a valid Stellar address.", "error");
      setError(walletValidation.error || "Wallet address must be a valid Stellar public key starting with G.");
      return;
    }

    if (rateLimited) {
      const message = formatRateLimitMessage(rateLimitRemainingMinutes);
      showToast(message, "error");
      setError(message);
      return;
    }

    setLoading(true);
    try {
      const acceptedAssets = assets
        .filter((a) => a.code.trim() !== "")
        .map((a) => ({ code: a.code.trim(), issuer: a.issuer.trim() || undefined }));

      const payload = { ...form, displayName: form.displayName.trim(), acceptedAssets };

      const res = await fetch(`${API_BASE_URL}/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const profile = await res.json();
        showToast("Profile created!", "success");
        setRateLimitAttempts(0);
        setRateLimitRetryAt(null);
        setTimeout(() => {
          router.push(`/profile/${profile.username}`);
        }, 2000);
      } else {
        const body = await res.json().catch(() => ({}));
        const code = typeof body.code === "string" ? body.code : "";
        const message =
          typeof body.error === "string"
            ? body.error
            : "Something went wrong. Please try again.";

        if (code === "USERNAME_TAKEN") {
          setStep(1);
          setFieldErrors({ username: "That username is already taken.", email: null });
          showToast("That username is already taken.", "error");
          setError("Username already taken.");
        } else if (code === "EMAIL_TAKEN") {
          setFieldErrors({ username: null, email: "That email address is already in use." });
          showToast("That email address is already in use.", "error");
          setError("Email already in use.");
        } else if (code === "RATE_LIMIT_EXCEEDED" || res.status === 429) {
          const retryAfterHeader = Number(res.headers.get("Retry-After"));
          const retryMinutes = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? Math.max(1, Math.ceil(retryAfterHeader / 60))
            : Math.min(60, 2 ** rateLimitAttempts || 1);
          const nextRetryAt = Date.now() + retryMinutes * 60_000;

          setRateLimitAttempts((current) => current + 1);
          setRateLimitRetryAt(nextRetryAt);
          const rateLimitMessage = formatRateLimitMessage(retryMinutes);
          showToast(rateLimitMessage, "error");
          setError(rateLimitMessage);
        } else {
          showToast(message, "error");
          setError(message);
        }
      }
    } catch {
      showToast("Something went wrong. Please try again.", "error");
      setError("Network error — please check your connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell>
      <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-8 shadow-xl shadow-black/20">
          <div className="flex gap-2 mb-8">
            {[1, 2, 3].map((s) => (
              <div
                key={s}
                className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
                  step >= s ? "bg-mint" : "bg-white/10"
                }`}
              />
            ))}
          </div>

          <h1 className="mt-4 text-[1.2rem] sm:text-4xl font-semibold tracking-tight text-white leading-tight">
            Create your&nbsp;
            <span className="text-mint">NovaSupport</span>&nbsp;profile
          </h1>
          <p className="mt-3 text-sm text-sky/70">
            Your public Stellar-native support page — shareable in seconds.
          </p>

          <div className="mt-8 space-y-5">
            {step === 1 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label htmlFor="display-name" className="text-[10px] uppercase tracking-[0.25em] text-steel">
                      Display Name <span className="text-mint">*</span>
                    </label>
                      <input
                        id="display-name"
                        type="text"
                        required
                        maxLength={64}
                        placeholder="e.g. Star Voyager"
                        value={form.displayName}
                        onChange={set("displayName")}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-steel/40 focus:border-mint/50 focus:outline-none focus:ring-1 focus:ring-mint/20 transition"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <label htmlFor="username" className="text-[10px] uppercase tracking-[0.25em] text-steel">
                      Username <span className="text-mint">*</span>
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-steel/60 text-sm select-none">
                        @
                      </span>
                      <input
                        id="username"
                        type="text"
                        required
                        maxLength={32}
                        pattern="[a-zA-Z0-9\-]+"
                        placeholder="username"
                        value={form.username}
                        onChange={set("username")}
                        className={`w-full rounded-2xl border bg-white/5 pl-8 pr-4 py-3 text-sm placeholder:text-steel/40 focus:outline-none focus:ring-1 transition ${
                          usernameFieldError
                            ? "border-red-500/40 text-red-300 focus:border-red-500/50 focus:ring-red-500/20"
                            : "border-white/10 text-white focus:border-mint/50 focus:ring-mint/20"
                        }`}
                      />
                    </div>
                    {usernameFieldError && (
                      <p className="text-[10px] text-red-400 pl-1">
                        {usernameFieldError}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <label htmlFor="bio" className="text-[10px] uppercase tracking-[0.25em] text-steel">
                      Bio
                    </label>
                    <span
                      className={`text-[10px] tabular-nums ${
                        form.bio.length >= 270 ? "text-red-400" : "text-steel/50"
                      }`}
                    >
                      {form.bio.length}&nbsp;/&nbsp;280
                    </span>
                  </div>
                  <textarea
                    id="bio"
                    maxLength={280}
                    rows={4}
                    placeholder="Tell the galaxy about your mission…"
                    value={form.bio}
                    onChange={set("bio")}
                    className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-steel/40 focus:border-mint/50 focus:outline-none focus:ring-1 focus:ring-mint/20 transition resize-none"
                  />
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex flex-col gap-2">
                  <label htmlFor="wallet-address" className="text-[10px] uppercase tracking-[0.25em] text-steel">
                    Stellar Wallet Address <span className="text-mint">*</span>
                  </label>
                  <div className="relative">
                    <input
                      id="wallet-address"
                      type="text"
                      required
                      placeholder="G…"
                      value={form.walletAddress}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        const cleaned = raw.startsWith("G") && raw.length > 56 ? raw.slice(0, 56) : raw;
                        setForm((prev) => ({ ...prev, walletAddress: cleaned }));
                        setError(null);
                      }}
                      className={`w-full rounded-2xl border bg-white/5 px-4 py-3 text-sm font-mono placeholder:text-steel/40 focus:outline-none focus:ring-1 transition ${
                        !walletValid && form.walletAddress
                          ? "border-red-500/40 text-red-400 focus:ring-red-500/20 focus:border-red-500/50"
                          : walletValid && form.walletAddress
                          ? "border-mint/40 text-mint focus:ring-mint/20 focus:border-mint/50"
                          : "border-white/10 text-white focus:border-mint/50 focus:ring-mint/20"
                      }`}
                    />
                    {form.walletAddress && (
                      <span
                        className={`absolute right-4 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-widest font-bold ${
                          walletValid ? "text-mint" : "text-red-400"
                        }`}
                      >
                        {walletValid ? "✓ Valid" : "✗ Invalid"}
                      </span>
                    )}
                  </div>
                  {form.walletAddress && !walletValidation.isValid && (
                    <div className="mt-2 rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-2 animate-in fade-in slide-in-from-top-1 duration-200">
                      <p className="text-[11px] font-medium text-red-400">
                        {walletValidation.error}
                      </p>
                    </div>
                  )}
                  {!form.walletAddress && (
                    <p className="text-[11px] text-steel/50 pl-1 mt-1">
                      Exactly <strong className="text-steel">56 characters</strong> starting with{" "}
                      <strong className="text-steel">G</strong> (letters A–Z, digits 2–7).
                      Example: <code className="text-xs text-sky/60">GABCDEFGHIJKLMNOPQRSTUVWXYZ234567</code>
                    </p>
                  )}
                  {form.walletAddress && walletValid && (
                    <p className="text-[11px] text-mint/70 pl-1 mt-1">
                      Valid Stellar address.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-3">
                  <label className="text-[10px] uppercase tracking-[0.25em] text-steel">
                    Accepted Assets <span className="text-mint">*</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {["XLM", "USDC", "AQUA", "yXLM", "yUSDC"].map((asset) => (
                      <button
                        key={asset}
                        type="button"
                        aria-pressed={assets.some((a) => a.code === asset)}
                        onClick={() => {
                          const isSelected = assets.some((a) => a.code === asset);
                          setAssets(
                            isSelected
                              ? assets.filter((a) => a.code !== asset)
                              : [...assets, { code: asset, issuer: KNOWN_ISSUERS[asset] ?? "" }]
                          );
                          setForm((prev) => ({
                            ...prev,
                            acceptedAssets: prev.acceptedAssets.includes(asset)
                              ? prev.acceptedAssets.filter((a) => a !== asset)
                              : [...prev.acceptedAssets, asset],
                          }));
                        }}
                        className={`rounded-xl border px-4 py-2 text-xs font-semibold transition ${
                          assets.some((a) => a.code === asset)
                            ? "border-mint bg-mint/10 text-mint"
                            : "border-white/10 bg-white/5 text-steel hover:border-white/20"
                        }`}
                      >
                        {asset}
                      </button>
                    ))}
                  </div>
                  {assets.some((a) => a.code !== "XLM") && (
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                      <p className="text-[10px] uppercase tracking-[0.25em] text-steel">
                        Asset issuers <span className="text-mint">*</span> — required for non-XLM assets
                      </p>
                      {assets
                        .filter((a) => a.code !== "XLM")
                        .map((asset) => (
                          <div key={asset.code} className="flex flex-col gap-1.5">
                            <label htmlFor={`issuer-${asset.code}`} className="text-xs font-medium text-steel">
                              {asset.code} issuer
                            </label>
                            <input
                              id={`issuer-${asset.code}`}
                              type="text"
                              placeholder={
                                KNOWN_ISSUERS[asset.code] ? `Default: ${KNOWN_ISSUERS[asset.code].slice(0, 8)}…` : "G… Stellar issuer address"
                              }
                              value={asset.issuer}
                              onChange={(e) => {
                                const val = e.target.value.trim();
                                setAssets((prev) =>
                                  prev.map((p) => (p.code === asset.code ? { ...p, issuer: val } : p))
                                );
                              }}
                              className={`w-full rounded-xl border bg-white/5 px-3 py-2 font-mono text-xs text-white placeholder:text-steel/40 focus:outline-none focus:ring-1 transition ${
                                asset.issuer.trim() === ""
                                  ? "border-amber-500/40 focus:border-amber-500/50 focus:ring-amber-500/20"
                                  : "border-white/10 focus:border-mint/50 focus:ring-mint/20"
                              }`}
                            />
                            {asset.issuer.trim() === "" && (
                              <p className="text-[10px] text-amber-400">
                                Issuer required — without it, this asset will not be accepted for payments.
                              </p>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label htmlFor="twitter-handle" className="text-[10px] uppercase tracking-[0.25em] text-steel">
                      Twitter / X
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-steel/60 text-sm select-none">
                        @
                      </span>
                      <input
                        id="twitter-handle"
                        type="text"
                        maxLength={15}
                        placeholder="handle"
                        value={form.twitterHandle}
                        onChange={set("twitterHandle")}
                        className="w-full rounded-2xl border border-white/10 bg-white/5 pl-8 pr-4 py-3 text-sm text-white placeholder:text-steel/40 focus:border-mint/50 focus:outline-none focus:ring-1 focus:ring-mint/20 transition"
                      />
                    </div>
                    {twitterInvalid && (
                      <p className="text-[10px] text-red-400 pl-1">
                        Letters, numbers, underscores only
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col gap-2">
                    <label htmlFor="github-handle" className="text-[10px] uppercase tracking-[0.25em] text-steel">
                      GitHub
                    </label>
                    <input
                      id="github-handle"
                      type="text"
                      maxLength={39}
                      placeholder="username"
                      value={form.githubHandle}
                      onChange={set("githubHandle")}
                      className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-steel/40 focus:border-mint/50 focus:outline-none focus:ring-1 focus:ring-mint/20 transition"
                    />
                    {githubInvalid && (
                      <p className="text-[10px] text-red-400 pl-1">
                        Letters, numbers, hyphens only
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="website-url" className="text-[10px] uppercase tracking-[0.25em] text-steel">
                    Website
                  </label>
                  <input
                    id="website-url"
                    type="url"
                    placeholder="https://yoursite.com"
                    value={form.websiteUrl}
                    onChange={set("websiteUrl")}
                    className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-steel/40 focus:border-mint/50 focus:outline-none focus:ring-1 focus:ring-mint/20 transition"
                  />
                  {form.websiteUrl && !websiteValid && (
                    <p className="text-[10px] text-red-400 pl-1">
                      URL must start with https://
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="email" className="text-[10px] uppercase tracking-[0.25em] text-steel">
                    Email (Private)
                  </label>
                  <input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={form.email}
                    onChange={set("email")}
                    className={`w-full rounded-2xl border bg-white/5 px-4 py-3 text-sm placeholder:text-steel/40 focus:outline-none focus:ring-1 transition ${
                      emailFieldError
                        ? "border-red-500/40 text-red-300 focus:border-red-500/50 focus:ring-red-500/20"
                        : "border-white/10 text-white focus:border-mint/50 focus:ring-mint/20"
                    }`}
                  />
                  {emailFieldError && (
                    <p className="text-[10px] text-red-400 pl-1">
                      {emailFieldError}
                    </p>
                  )}
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            {rateLimited && (
              <p className="text-sm text-gold">
                {formatRateLimitMessage(rateLimitRemainingMinutes)}
              </p>
            )}

            <div className="flex gap-4 pt-4">
              {step > 1 && (
                <button
                  type="button"
                  onClick={handleBack}
                  className="flex-1 rounded-full border border-white/10 bg-white/5 px-5 py-4 text-sm font-semibold text-white transition hover:bg-white/10 active:scale-[0.98]"
                >
                  ← Back
                </button>
              )}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={loading || rateLimited}
                className="flex-[2] flex items-center justify-center gap-2 rounded-full bg-mint px-5 py-4 text-sm font-semibold text-ink transition hover:bg-white active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading && (
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink border-t-transparent" />
                )}
                {rateLimited
                  ? `Try again in ${rateLimitRemainingMinutes} minute${rateLimitRemainingMinutes === 1 ? "" : "s"}`
                  : loading
                  ? "Creating profile…"
                  : step === 3
                  ? "Create Profile →"
                  : "Continue"}
              </button>
            </div>

            <p className="text-center text-[10px] uppercase tracking-[0.2em] text-steel/35">
              By continuing you agree to the{" "}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-steel/60 transition"
              >
                NovaSupport Protocol Terms
              </a>
              .
            </p>
          </div>
        </div>

        <aside className="rounded-[2rem] border border-white/10 bg-ocean/60 p-8">
          <p className="text-xs uppercase tracking-[0.25em] text-gold">
            What you get
          </p>
          <div className="mt-5 space-y-3">
            {[
              "A shareable public Stellar-native support page",
              "Accept XLM, USDC, AQUA and any Stellar asset",
              "On-chain transaction history visible to everyone",
              "Soroban-ready contract path for support events",
            ].map((item) => (
              <div
                key={item}
                className="rounded-3xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-sky/85"
              >
                {item}
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-3xl border border-mint/25 bg-ink/50 p-5 text-sm">
            <p className="font-semibold text-white mb-3">Field constraints</p>
            <ul className="space-y-2.5">
              {CONSTRAINTS.map(({ field, rule }) => (
                <li key={field} className="flex justify-between gap-4">
                  <span className="text-steel font-medium shrink-0">{field}</span>
                  <span className="text-sky/60 text-xs text-right">{rule}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 rounded-3xl border border-white/10 bg-white/5 px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-[0.25em] text-steel">
                Draft progress
              </span>
              <span className="text-[10px] text-mint font-bold">Step {step} / 3</span>
            </div>
            <div className="">
              <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-mint transition-all duration-500" 
                  style={{ width: `${(step / 3) * 100}%` }}
                />
              </div>
            </div>
            <p className="mt-3 text-[11px] text-sky/50">
              {step === 1 && "Next: Choose accepted assets and wallet."}
              {step === 2 && "Next: Add your social links."}
              {step === 3 && "Almost done! Click create to publish."}
            </p>
          </div>
        </aside>
      </section>
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={dismiss}
        />
      )}
    </AppShell>
  );
}
