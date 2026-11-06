export interface Mail {
  from: string;
  to: string;
  subject: string;
  body: string;
  id: string;
  date: string;
}

export interface MailLine {
  read(): Promise<string | null>;
  write(said: string): Promise<void>;
}

const LAST_LINE = /^\d{3}( |$)/;

const messageOf = ({ from, to, subject, body, id, date }: Mail): string => {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${id}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  // A line that starts with a dot would otherwise end the message, or lose its dot, on the way.
  const lines = body.split(/\r?\n/).map((one) => (one.startsWith(".") ? `.${one}` : one));
  return [...headers, "", ...lines].join("\r\n");
};

export const sendOverSmtp = async (line: MailLine, mail: Mail, password: string): Promise<void> => {
  let held = "";
  const reply = async (): Promise<number> => {
    for (;;) {
      const end = held.indexOf("\r\n");
      if (end >= 0) {
        const one = held.slice(0, end);
        held = held.slice(end + 2);
        if (LAST_LINE.test(one)) return Number(one.slice(0, 3));
      } else {
        const more = await line.read();
        if (more === null) throw new Error("the mail server closed the line");
        held += more;
      }
    }
  };
  const expect = async (step: string, code: number): Promise<void> => {
    const got = await reply();
    if (got !== code) throw new Error(`the mail server answered ${got} to ${step}`);
  };
  const say = async (step: string, said: string, code: number): Promise<void> => {
    await line.write(`${said}\r\n`);
    await expect(step, code);
  };

  await expect("the greeting", 220);
  await say("EHLO", "EHLO folio", 250);
  await say("AUTH", `AUTH PLAIN ${btoa(`\0${mail.from}\0${password}`)}`, 235);
  await say("MAIL", `MAIL FROM:<${mail.from}>`, 250);
  await say("RCPT", `RCPT TO:<${mail.to}>`, 250);
  await say("DATA", "DATA", 354);
  await say("the message", `${messageOf(mail)}\r\n.`, 250);
  await line.write("QUIT\r\n");
};
