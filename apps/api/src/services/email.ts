import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";
import { Resend } from "resend";

import type { Env } from "../env.js";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type EmailProvider = {
  readonly kind: "resend" | "smtp" | "console";
  sendPasswordReset(to: string, link: string): Promise<void>;
  sendVerification(to: string, link: string): Promise<void>;
};

type EmailContent = {
  subject: string;
  html: string;
  text: string;
};

function passwordResetContent(link: string): EmailContent {
  return {
    subject: "[생활비 매니저] 비밀번호 재설정",
    text: `비밀번호를 재설정하려면 다음 링크를 여세요 (1시간 내 유효):\n${link}\n\n요청하지 않았다면 이 메일을 무시하세요.`,
    html: renderTemplate(
      "비밀번호 재설정",
      "아래 버튼을 눌러 비밀번호를 재설정하세요. 이 링크는 1시간 동안만 유효합니다.",
      "비밀번호 재설정",
      link,
      "본인이 요청하지 않았다면 이 메일을 무시하세요. 비밀번호는 변경되지 않습니다."
    )
  };
}

function verificationContent(link: string): EmailContent {
  return {
    subject: "[생활비 매니저] 이메일 인증",
    text: `이메일을 인증하려면 다음 링크를 여세요 (24시간 내 유효):\n${link}`,
    html: renderTemplate(
      "이메일 인증",
      "아래 버튼을 눌러 이메일 주소를 인증하세요. 이 링크는 24시간 동안 유효합니다.",
      "이메일 인증하기",
      link,
      "본인이 가입하지 않았다면 이 메일을 무시하세요."
    )
  };
}

function renderTemplate(
  heading: string,
  body: string,
  cta: string,
  link: string,
  footer: string
): string {
  return [
    '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#18181b">',
    `<h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>`,
    `<p style="font-size:14px;line-height:1.6;color:#3f3f46">${body}</p>`,
    `<p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">${cta}</a></p>`,
    `<p style="font-size:12px;color:#71717a;word-break:break-all">${link}</p>`,
    `<p style="font-size:12px;color:#a1a1aa;margin-top:24px">${footer}</p>`,
    "</div>"
  ].join("");
}

class ResendProvider implements EmailProvider {
  readonly kind = "resend" as const;
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string
  ) {
    this.client = new Resend(apiKey);
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    await this.send(to, passwordResetContent(link));
  }

  async sendVerification(to: string, link: string): Promise<void> {
    await this.send(to, verificationContent(link));
  }

  private async send(to: string, content: EmailContent): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: [to],
      subject: content.subject,
      html: content.html,
      text: content.text
    });
    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }
}

class SmtpProvider implements EmailProvider {
  readonly kind = "smtp" as const;
  private readonly transporter: nodemailer.Transporter;

  constructor(
    options: { host: string; port: number; user: string; pass: string },
    private readonly from: string
  ) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      auth: { user: options.user, pass: options.pass }
    });
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    await this.send(to, passwordResetContent(link));
  }

  async sendVerification(to: string, link: string): Promise<void> {
    await this.send(to, verificationContent(link));
  }

  private async send(to: string, content: EmailContent): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: content.subject,
      html: content.html,
      text: content.text
    });
  }
}

class ConsoleProvider implements EmailProvider {
  readonly kind = "console" as const;

  constructor(private readonly logger?: FastifyBaseLogger) {}

  async sendPasswordReset(to: string, link: string): Promise<void> {
    this.log("password-reset", to, link);
  }

  async sendVerification(to: string, link: string): Promise<void> {
    this.log("email-verification", to, link);
  }

  private log(kind: string, to: string, link: string): void {
    const message = `[email:console] ${kind} -> ${to} | ${link}`;
    if (this.logger) {
      this.logger.info({ emailKind: kind, to, link }, message);
    } else {
      console.info(message);
    }
  }
}

/**
 * Selects an email provider. Priority: explicit EMAIL_PROVIDER, else by available
 * credentials (resend > smtp), else console (dev / unconfigured) so the rest of
 * the flow stays testable without a real mail service.
 */
export function createEmailProvider(env: Env, logger?: FastifyBaseLogger): EmailProvider {
  const explicit = env.EMAIL_PROVIDER;
  const hasResend = !!env.RESEND_API_KEY;
  const hasSmtp = !!(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS);

  if (explicit === "resend" || (!explicit && hasResend)) {
    if (!env.RESEND_API_KEY) {
      throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY");
    }
    return new ResendProvider(env.RESEND_API_KEY, env.EMAIL_FROM);
  }

  if (explicit === "smtp" || (!explicit && hasSmtp)) {
    if (!(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS)) {
      throw new Error("EMAIL_PROVIDER=smtp requires SMTP_HOST/PORT/USER/PASS");
    }
    return new SmtpProvider(
      { host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS },
      env.EMAIL_FROM
    );
  }

  return new ConsoleProvider(logger);
}
