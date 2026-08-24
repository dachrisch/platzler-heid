import nodemailer from "nodemailer";

export interface EmailSender {
  send(to: string, subject: string, body: string, html?: string): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  async send(to: string, subject: string, body: string, html?: string): Promise<void> {
    console.log(`\n--- email to ${to} ---\n${subject}\n${body}\n---\n`);
    if (html) console.log(`(HTML version available, ${html.length} bytes)`);
  }
}

export interface MailTransporter {
  sendMail(options: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown>;
}

export class SmtpEmailSender implements EmailSender {
  constructor(
    private transporter: MailTransporter,
    private from: string,
  ) {}

  async send(to: string, subject: string, body: string, html?: string): Promise<void> {
    const opts: { from: string; to: string; subject: string; text: string; html?: string } = {
      from: this.from,
      to,
      subject,
      text: body,
    };
    if (html) opts.html = html;
    await this.transporter.sendMail(opts);
  }
}

/** Builds the real SMTP sender, or a console logger when SMTP_HOST is unset (dev fallback). */
export function createEmailSender(): EmailSender {
  return process.env.SMTP_HOST
    ? new SmtpEmailSender(
        nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        }),
        process.env.SMTP_FROM ?? "festzelt@lehel.xyz",
      )
    : new ConsoleEmailSender();
}