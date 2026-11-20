import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Privacy Policy · NovaSupport",
  description:
    "Learn how NovaSupport collects, uses, and protects your data — including wallet addresses, on-chain data, and GDPR/CCPA rights.",
  openGraph: {
    title: "Privacy Policy · NovaSupport",
    description:
      "Learn how NovaSupport handles your data on the Stellar-native creator support platform.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Privacy Policy · NovaSupport",
    description:
      "Learn how NovaSupport handles your data on the Stellar-native creator support platform.",
  },
};

export default function PrivacyPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-16 space-y-10 text-sky/80">
        <header className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight text-white">
            Privacy Policy
          </h1>
          <p className="text-sm text-steel">Last updated: July 24, 2026</p>
        </header>

        <Section title="1. Introduction">
          <p>
            NovaSupport (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) operates the NovaSupport
            platform, a Stellar-native creator support service. This Privacy
            Policy explains what personal data we collect, why we collect it,
            how we use it, and the rights you have regarding your information.
          </p>
          <p>
            By using NovaSupport you agree to the practices described in this
            Policy. If you do not agree, please discontinue use of the Platform.
          </p>
        </Section>

        <Section title="2. Data We Collect">
          <h3 className="text-white font-medium mt-2">
            2.1 Data you provide directly
          </h3>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>
              <strong className="text-white/80">Display name and bio</strong> —
              shown publicly on your creator profile.
            </li>
            <li>
              <strong className="text-white/80">Email address</strong> —
              optional; used only for notification emails. Never shown publicly.
            </li>
            <li>
              <strong className="text-white/80">Social handles</strong> (Twitter,
              GitHub) — optional; shown publicly on your profile.
            </li>
            <li>
              <strong className="text-white/80">Website URL</strong> — optional;
              shown on your profile.
            </li>
            <li>
              <strong className="text-white/80">Avatar image</strong> — uploaded
              to and served from Supabase Storage.
            </li>
          </ul>

          <h3 className="text-white font-medium mt-4">
            2.2 Wallet addresses
          </h3>
          <p>
            Your Stellar wallet public key (G…) is used to authenticate you and
            to route supporter payments to you. It is stored in our database and
            displayed publicly on your profile page. It is also recorded
            permanently on the Stellar blockchain for every transaction. We never
            have access to your private key or seed phrase.
          </p>

          <h3 className="text-white font-medium mt-4">2.3 On-chain data</h3>
          <p>
            When a supporter sends you Stellar assets, the transaction hash,
            amount, asset code, sender address, and timestamp are recorded on the
            Stellar Network and in our database. This data is public by nature
            of the Stellar blockchain and cannot be deleted from the ledger.
          </p>

          <h3 className="text-white font-medium mt-4">
            2.4 Automatically collected data
          </h3>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>
              IP addresses — used transiently for rate limiting; not linked to
              your profile and not stored long-term. When you submit a profile
              report, the reporter&apos;s IP address is additionally retained
              for up to 90 days to support abuse investigations, then
              automatically purged.
            </li>
            <li>
              HTTP request logs — retained for up to 30 days for security and
              diagnostics, then purged.
            </li>
            <li>
              Profile view counts — aggregate only; no individual visitor
              tracking.
            </li>
          </ul>
        </Section>

        <Section title="3. How We Use Your Data">
          <ul className="list-disc pl-6 space-y-1">
            <li>To authenticate you via Stellar wallet signature.</li>
            <li>
              To display your public creator profile to potential supporters.
            </li>
            <li>
              To send transactional email notifications when you receive
              support (if you have verified an email address and enabled this
              option).
            </li>
            <li>To process and verify Stellar payment transactions.</li>
            <li>
              To enforce rate limits and protect the Platform from abuse.
            </li>
            <li>
              To send optional weekly digest emails summarising your support
              activity (opt-in only).
            </li>
          </ul>
          <p className="mt-2">
            We do not sell, rent, or trade your personal data to third parties.
          </p>
        </Section>

        <Section title="4. Data Sharing">
          <p>We share data with the following third parties only as necessary:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              <strong className="text-white/80">Supabase</strong> — database
              hosting and avatar image storage. Data is processed under their
              Data Processing Agreement.
            </li>
            <li>
              <strong className="text-white/80">SMTP provider</strong> — for
              transactional email delivery. Only your email address and first
              name are transmitted.
            </li>
            <li>
              <strong className="text-white/80">Sentry</strong> — error
              monitoring. Wallet addresses may appear in error traces; we
              configure Sentry to scrub PII where possible.
            </li>
            <li>
              <strong className="text-white/80">Stellar Network</strong> —
              transaction data is broadcast to and permanently stored on the
              public Stellar blockchain.
            </li>
          </ul>
        </Section>

        <Section title="5. Cookies and Local Storage">
          <p>
            NovaSupport uses an <strong className="text-white/80">httpOnly
            cookie</strong> named <code className="text-mint text-xs bg-white/5 px-1 py-0.5 rounded">auth_token</code> to
            maintain your authenticated session. This cookie is set after you
            sign in with your Stellar wallet, expires after 1 hour, and is not
            accessible to JavaScript (reducing XSS risk).
          </p>
          <p className="mt-2">
            We use browser <code className="text-mint text-xs bg-white/5 px-1 py-0.5 rounded">localStorage</code> to
            store your chosen username and UI preferences (e.g. theme). No
            tracking or advertising cookies are used.
          </p>
        </Section>

        <Section title="6. Data Retention">
          <ul className="list-disc pl-6 space-y-1">
            <li>
              Profile data is retained for as long as your account is active.
            </li>
            <li>
              Transaction records are retained indefinitely for audit and
              compliance purposes (they are also immutably recorded on the
              Stellar blockchain).
            </li>
            <li>
              Email addresses are deleted within 30 days of account deletion.
            </li>
            <li>HTTP logs are purged after 30 days.</li>
          </ul>
        </Section>

        <Section title="7. Your Rights (GDPR & CCPA)">
          <p>
            Depending on where you are located, you may have the following
            rights:
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              <strong className="text-white/80">Access</strong> — request a copy
              of the personal data we hold about you.
            </li>
            <li>
              <strong className="text-white/80">Rectification</strong> — correct
              inaccurate personal data via your profile settings.
            </li>
            <li>
              <strong className="text-white/80">Erasure (&quot;right to be
              forgotten&quot;)</strong> — request deletion of your profile and
              off-chain data. Note that on-chain transaction data cannot be
              erased from the Stellar blockchain.
            </li>
            <li>
              <strong className="text-white/80">Portability</strong> — export
              your transaction history as CSV via the Creator Dashboard.
            </li>
            <li>
              <strong className="text-white/80">Opt-out of sale</strong> — we do
              not sell personal data; this right is satisfied by default.
            </li>
            <li>
              <strong className="text-white/80">Withdraw consent</strong> —
              unsubscribe from email notifications at any time in your
              Notification Preferences.
            </li>
          </ul>
          <p className="mt-2">
            To exercise these rights, email{" "}
            <a
              href="mailto:privacy@novasupport.xyz"
              className="text-mint hover:underline"
            >
              privacy@novasupport.xyz
            </a>
            . We will respond within 30 days.
          </p>
        </Section>

        <Section title="8. Security">
          <p>
            We implement industry-standard security measures including HTTPS
            encryption in transit, httpOnly session cookies, rate limiting, CORS
            restrictions, and input sanitisation. However, no system is
            completely secure. You are responsible for securing your Stellar
            wallet private key.
          </p>
        </Section>

        <Section title="9. Children's Privacy">
          <p>
            NovaSupport is not directed at children under 18. We do not
            knowingly collect personal data from minors. If you believe a minor
            has provided us with personal data, please contact us immediately.
          </p>
        </Section>

        <Section title="10. Changes to This Policy">
          <p>
            We may update this Privacy Policy periodically. Changes will be
            posted on this page with an updated &quot;Last updated&quot; date. Continued
            use of the Platform after changes constitutes acceptance of the
            revised Policy.
          </p>
        </Section>

        <Section title="11. Contact">
          <p>
            For privacy-related questions, contact us at{" "}
            <a
              href="mailto:privacy@novasupport.xyz"
              className="text-mint hover:underline"
            >
              privacy@novasupport.xyz
            </a>
            .
          </p>
        </Section>

        <div className="border-t border-white/10 pt-8 text-sm text-steel flex gap-6">
          <Link href="/terms" className="hover:text-mint transition-colors">
            Terms of Service
          </Link>
          <Link href="/" className="hover:text-mint transition-colors">
            ← Back to Home
          </Link>
        </div>
      </div>
    </AppShell>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <div className="text-sky/70 leading-relaxed space-y-2">{children}</div>
    </section>
  );
}
