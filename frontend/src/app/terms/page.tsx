import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Terms of Service · NovaSupport",
  description:
    "Read the NovaSupport Terms of Service — rules and responsibilities for using the Stellar-native creator support platform.",
  openGraph: {
    title: "Terms of Service · NovaSupport",
    description:
      "Read the NovaSupport Terms of Service for the Stellar-native creator support platform.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Terms of Service · NovaSupport",
    description:
      "Read the NovaSupport Terms of Service for the Stellar-native creator support platform.",
  },
};

export default function TermsPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-16 space-y-10 text-sky/80">
        <header className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight text-white">
            Terms of Service
          </h1>
          <p className="text-sm text-steel">Last updated: July 24, 2026</p>
        </header>

        <Section title="1. Acceptance of Terms">
          <p>
            By accessing or using NovaSupport (&quot;the Platform&quot;), you agree to be
            bound by these Terms of Service (&quot;Terms&quot;). If you do not agree to
            these Terms, do not use the Platform. These Terms govern your use of
            all services provided by NovaSupport, including but not limited to
            the creator profile pages, Stellar payment integrations, and
            dashboard features.
          </p>
        </Section>

        <Section title="2. Description of Service">
          <p>
            NovaSupport is a decentralised creator support platform built on the
            Stellar Network. It allows creators to publish a public profile page
            through which supporters can send Stellar assets (XLM, USDC, and
            other Stellar-native tokens) directly to the creator&apos;s on-chain
            wallet address. NovaSupport does not custody, hold, or transmit
            funds on behalf of any party.
          </p>
        </Section>

        <Section title="3. Eligibility">
          <p>
            You must be at least 18 years old and have the legal capacity to
            enter into contracts to use the Platform. By using the Platform, you
            represent and warrant that you meet these requirements.
          </p>
        </Section>

        <Section title="4. Wallet Addresses and On-Chain Transactions">
          <p>
            NovaSupport uses Stellar wallet addresses for authentication and
            payment routing. By connecting a wallet you acknowledge that:
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              Your wallet address is public by design on the Stellar Network and
              will be displayed on your profile page.
            </li>
            <li>
              All transactions are executed on-chain and are irreversible once
              submitted to the Stellar Network.
            </li>
            <li>
              NovaSupport does not have access to your private key or seed
              phrase and cannot reverse, refund, or alter any transaction.
            </li>
            <li>
              You are solely responsible for the security of your wallet
              credentials.
            </li>
          </ul>
        </Section>

        <Section title="5. Creator Responsibilities">
          <p>As a creator using NovaSupport, you agree to:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              Provide accurate and complete information in your profile.
            </li>
            <li>
              Not use the Platform for unlawful purposes, fraud, or to
              facilitate money laundering.
            </li>
            <li>
              Not impersonate any person or entity or misrepresent your
              affiliation.
            </li>
            <li>
              Comply with all applicable laws and regulations, including tax
              obligations arising from funds received through the Platform.
            </li>
          </ul>
        </Section>

        <Section title="6. Supporter Responsibilities">
          <p>As a supporter, you acknowledge that:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              Support payments are voluntary gifts and do not constitute
              purchases of goods or services unless explicitly stated by the
              creator.
            </li>
            <li>
              NovaSupport is not responsible for how creators use funds received
              through the Platform.
            </li>
            <li>Transactions are final and non-refundable.</li>
          </ul>
        </Section>

        <Section title="7. Intellectual Property">
          <p>
            All content you submit to NovaSupport (profile text, avatar images,
            milestone descriptions) remains your property. You grant NovaSupport
            a non-exclusive, royalty-free licence to display that content on the
            Platform for the purpose of providing the service. NovaSupport&apos;s own
            software, design, and trade marks are the property of NovaSupport
            and may not be used without prior written consent.
          </p>
        </Section>

        <Section title="8. Disclaimer of Warranties">
          <p>
            The Platform is provided &quot;as is&quot; and &quot;as available&quot; without
            warranties of any kind, either express or implied. NovaSupport does
            not warrant that the Platform will be uninterrupted, error-free, or
            free from harmful components. Use of the Platform is at your own
            risk.
          </p>
        </Section>

        <Section title="9. Limitation of Liability">
          <p>
            To the maximum extent permitted by law, NovaSupport and its
            affiliates shall not be liable for any indirect, incidental, special,
            consequential, or punitive damages arising out of or related to your
            use of the Platform, including loss of funds due to wallet compromise
            or on-chain errors.
          </p>
        </Section>

        <Section title="10. Changes to Terms">
          <p>
            We reserve the right to modify these Terms at any time. Changes will
            be effective upon posting to this page with an updated &quot;Last updated&quot;
            date. Continued use of the Platform after changes constitutes your
            acceptance of the revised Terms.
          </p>
        </Section>

        <Section title="11. Governing Law">
          <p>
            These Terms shall be governed by and construed in accordance with
            applicable law. Any disputes shall be resolved through binding
            arbitration or the courts of competent jurisdiction.
          </p>
        </Section>

        <Section title="12. Contact">
          <p>
            Questions about these Terms? Email us at{" "}
            <a
              href="mailto:legal@novasupport.xyz"
              className="text-mint hover:underline"
            >
              legal@novasupport.xyz
            </a>
            .
          </p>
        </Section>

        <div className="border-t border-white/10 pt-8 text-sm text-steel flex gap-6">
          <Link href="/privacy" className="hover:text-mint transition-colors">
            Privacy Policy
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
