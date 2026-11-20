import { sendEmail } from "../mailer.js";
import { escapeHtml } from "../services/email.js";

const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export async function sendVerificationEmail(
  to: string,
  username: string,
  token: string,
): Promise<void> {
  const verifyUrl = `${APP_URL}/profiles/${encodeURIComponent(username)}/verify-email?token=${encodeURIComponent(token)}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1e293b;">
      <h2 style="color: #6366f1;">Verify your NovaSupport email address</h2>
      <p>Hi ${escapeHtml(username)},</p>
      <p>Thank you for joining NovaSupport! Please verify your email address by clicking the button below. This helps ensure your account is secure and you receive important notifications about your support transactions.</p>
      <div style="margin: 32px 0;">
        <a href="${verifyUrl}" style="display:inline-block;padding:14px 28px;background:#6366f1;color:#fff;text-decoration:none;border-radius:12px;font-weight: 600;">Verify email address</a>
      </div>
      <p style="font-size: 14px; color: #64748b;">The link will expire in 24 hours.</p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 32px 0;" />
      <p style="font-size: 12px; color: #94a3b8;">Or paste this URL into your browser:<br><code style="background: #f1f5f9; padding: 4px 8px; border-radius: 4px; display: block; margin-top: 8px;">${verifyUrl}</code></p>
      <p style="font-size: 12px; color: #94a3b8;">If you did not request this, you can safely ignore this message.</p>
      <p style="margin-top: 32px;">Thanks,<br/>The NovaSupport Team</p>
    </div>
  `.trim();

  await sendEmail({
    to,
    subject: "Verify your NovaSupport email address",
    html,
    text: `Hi ${username},\n\nVerify your email address to secure your account on NovaSupport:\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not request this, ignore this message.`,
  });
}
