import { sendEmail } from "../mailer.js";
import { stellarExplorerNetwork } from "../network.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

interface SendSupportReceivedEmailParams {
  to: string;
  fromAddress: string;
  amount: string;
  assetCode: string;
  message?: string | null;
  txHash: string;
}

export async function sendSupportReceivedEmail({
  to,
  fromAddress,
  amount,
  assetCode,
  message,
  txHash,
}: SendSupportReceivedEmailParams): Promise<void> {
  const subject = `You received ${amount} ${assetCode} on NovaSupport`;

  const truncatedAddress = fromAddress.length > 8
    ? `${fromAddress.slice(0, 4)}...${fromAddress.slice(-4)}`
    : fromAddress;

  const network = stellarExplorerNetwork();
  const stellarExpertLink = `https://stellar.expert/explorer/${network}/tx/${txHash}`;

  const html = `
    <h2>You've received support!</h2>
    <p>A supporter (${escapeHtml(truncatedAddress)}) has sent you <strong>${escapeHtml(amount)} ${escapeHtml(assetCode)}</strong>.</p>
    ${message ? `<p><strong>Message:</strong> "${escapeHtml(message)}"</p>` : ""}
    <p><a href="${stellarExpertLink}">View transaction on Stellar Expert</a></p>
    <br/>
    <p>Thanks,<br/>The NovaSupport Team</p>
  `;

  await sendEmail({
    to,
    subject,
    html,
  });
}

interface SendMilestoneReachedEmailParams {
  to: string;
  milestoneName: string;
  targetAmount: string;
  assetCode: string;
}

export async function sendMilestoneReachedEmail({
  to,
  milestoneName,
  targetAmount,
  assetCode,
}: SendMilestoneReachedEmailParams): Promise<void> {
  const subject = `Milestone reached: ${milestoneName}`;

  const html = `
    <h2>Congratulations! You've reached a milestone! 🎉</h2>
    <p>Your milestone "<strong>${escapeHtml(milestoneName)}</strong>" has been reached!</p>
    <p>Target: <strong>${escapeHtml(targetAmount)} ${escapeHtml(assetCode)}</strong></p>
    <p>Thank you for your dedication and the support from your community.</p>
    <br/>
    <p>Keep up the great work!<br/>The NovaSupport Team</p>
  `;

  await sendEmail({
    to,
    subject,
    html,
  });
}
