import { connect } from "cloudflare:sockets";
import { sendOverSmtp } from "../core/smtp";

const HOST = "smtp.migadu.com";
const PORT = 465;
const GIVES_UP_AFTER_MS = 15_000;

export interface MailBindings {
  MAIL_USER?: string;
  MAIL_PASSWORD?: string;
  ALERT_TO?: string;
}

export const sendMail = async (env: MailBindings, subject: string, body: string): Promise<void> => {
  const { MAIL_USER: from, MAIL_PASSWORD: password, ALERT_TO: to } = env;
  if (!from || !password || !to) throw new Error("there is nowhere to send the mail");

  const socket = connect({ hostname: HOST, port: PORT }, { secureTransport: "on", allowHalfOpen: false });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the mail server took too long")), GIVES_UP_AFTER_MS);
  });
  const mail = {
    from,
    to,
    subject,
    body,
    id: `${crypto.randomUUID()}@${from.slice(from.indexOf("@") + 1)}`,
    date: new Date().toUTCString(),
  };
  const line = {
    read: async () => {
      const { done, value } = await reader.read();
      return done ? null : decoder.decode(value, { stream: true });
    },
    write: (said: string) => writer.write(encoder.encode(said)),
  };
  try {
    await Promise.race([sendOverSmtp(line, mail, password), late]);
  } finally {
    clearTimeout(timer);
    await socket.close().catch(() => {});
  }
};
