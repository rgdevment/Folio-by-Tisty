import { describe, expect, it } from "vitest";
import { type Mail, sendOverSmtp } from "../src/core/smtp";

const MAIL: Mail = {
  from: "avisos@tisty.app",
  to: "persona@example.com",
  subject: "Folio: denuncia",
  body: '{\n  "doc": "k7Qm2xPa"\n}',
  id: "uno@tisty.app",
  date: "Thu, 05 Nov 2026 01:00:00 GMT",
};
const PASSWORD = "no-debe-salir";

const HAPPY = ["220 hi", "250-mail\r\n250 8BITMIME", "235 ok", "250 ok", "250 ok", "354 go", "250 queued"];

// Answers in order, each only after what came before was said, as a server does.
const serverAnswering = (answers: string[]) => {
  const written: string[] = [];
  const left = [...answers];
  return {
    written,
    line: {
      read: async () => {
        const next = left.shift();
        return next === undefined ? null : `${next}\r\n`;
      },
      write: async (said: string) => {
        written.push(said);
      },
    },
  };
};

describe("sending a mail", () => {
  it("says each step in its order, and signs in as who sends it", async () => {
    const { line, written } = serverAnswering(HAPPY);
    await sendOverSmtp(line, MAIL, PASSWORD);
    expect(written.map((one) => one.split(" ")[0]?.split("\r")[0])).toEqual([
      "EHLO",
      "AUTH",
      "MAIL",
      "RCPT",
      "DATA",
      "From:",
      "QUIT",
    ]);
    expect(written[1]).toBe(`AUTH PLAIN ${btoa(`\0${MAIL.from}\0${PASSWORD}`)}\r\n`);
    expect(written[2]).toBe("MAIL FROM:<avisos@tisty.app>\r\n");
    expect(written[3]).toBe("RCPT TO:<persona@example.com>\r\n");
  });

  it("writes a message a mail server takes: headers, a blank line, and the end mark", async () => {
    const { line, written } = serverAnswering(HAPPY);
    await sendOverSmtp(line, MAIL, PASSWORD);
    const message = written[5] as string;
    expect(message).toContain("Subject: Folio: denuncia\r\n");
    expect(message).toContain("Message-ID: <uno@tisty.app>\r\n");
    expect(message).toContain('\r\n\r\n{\r\n  "doc": "k7Qm2xPa"\r\n}');
    expect(message.endsWith("\r\n.\r\n")).toBe(true);
  });

  it("doubles a dot at the start of a line, so a body cannot end the message", async () => {
    const { line, written } = serverAnswering(HAPPY);
    await sendOverSmtp(line, { ...MAIL, body: "uno\n.\ndos" }, PASSWORD);
    expect(written[5]).toContain("\r\nuno\r\n..\r\ndos\r\n.\r\n");
  });

  it("reads an answer that arrives in pieces, or in several lines", async () => {
    const pieces = [
      "22",
      "0 hi\r\n250-a\r\n250-b",
      "\r\n250 c\r\n",
      "235 ok\r\n",
      "250 ok\r\n250 ok\r\n",
      "354 go\r\n250 ok\r\n",
    ];
    const written: string[] = [];
    const line = {
      read: async () => pieces.shift() ?? null,
      write: async (said: string) => {
        written.push(said);
      },
    };
    await sendOverSmtp(line, MAIL, PASSWORD);
    expect(written.at(-1)).toBe("QUIT\r\n");
  });

  it("fails at the step refused, and never says the password", async () => {
    const { line, written } = serverAnswering(["220 hi", "250 ok", `535 bad ${PASSWORD}`]);
    const failure = await sendOverSmtp(line, MAIL, PASSWORD).catch((error: Error) => error);
    expect(String(failure)).toContain("535 to AUTH");
    expect(String(failure)).not.toContain(PASSWORD);
    expect(written.some((one) => one.startsWith("MAIL"))).toBe(false);
  });

  it("fails when a limit turns it down, so the alert goes again", async () => {
    const { line } = serverAnswering(["220 hi", "250 ok", "235 ok", "550 over the day's limit"]);
    await expect(sendOverSmtp(line, MAIL, PASSWORD)).rejects.toThrow("550 to MAIL");
  });

  it("fails when the line closes halfway", async () => {
    const { line } = serverAnswering(["220 hi"]);
    await expect(sendOverSmtp(line, MAIL, PASSWORD)).rejects.toThrow("closed the line");
  });
});
