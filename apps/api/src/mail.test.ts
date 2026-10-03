import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import test from "node:test";

// Exercise the real transport against a loopback SMTP receiver. No external
// provider, account, or database is involved in this dependency regression test.
test("action emails authenticate, deliver multipart mail and propagate SMTP rejection", { timeout: 15_000 }, async (t) => {
  const messages: string[] = [];
  const envelopes: string[] = [];
  const authentications: string[] = [];
  const sockets = new Set<Socket>();
  const credentials = "\0smtp-test-user\0smtp-test-password";
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost SMTP test receiver\r\n");
    let buffer = "";
    let message: string[] | undefined;
    let authenticated = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (message) {
          if (line === ".") {
            messages.push(message.join("\r\n"));
            message = undefined;
            socket.write("250 Message accepted\r\n");
          } else {
            message.push(line.replace(/^\.\./, "."));
          }
        } else if (line.startsWith("EHLO ")) {
          socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        } else if (line.startsWith("AUTH PLAIN ")) {
          const supplied = Buffer.from(line.slice(11), "base64").toString();
          authentications.push(supplied);
          authenticated = supplied === credentials;
          socket.write(
            authenticated
              ? "235 Authenticated\r\n"
              : "535 Invalid credentials\r\n",
          );
        } else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) {
          envelopes.push(line);
          const response = !authenticated
            ? "530 Authentication required"
            : line.includes("rejected@example.com")
              ? "550 Recipient rejected"
              : "250 OK";
          socket.write(`${response}\r\n`);
        } else if (line === "DATA") {
          message = [];
          socket.write("354 End with a dot\r\n");
        } else if (line === "QUIT") {
          socket.end("221 Bye\r\n");
        } else {
          socket.write("502 Command not implemented\r\n");
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const environment = {
    NODE_ENV: "test",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(address.port),
    SMTP_SECURE: "false",
    SMTP_USER: "smtp-test-user",
    SMTP_PASSWORD: "smtp-test-password",
    SMTP_FROM: "Vardum <sender@example.com>",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { sendActionEmail, smtpEnabled } = await import("./mail.js");
  assert.equal(smtpEnabled, true);
  const subjects = [
    "Verify your Vardum email",
    "Reset your Vardum password",
    "Confirm your Vardum email change",
    "Join Test on Vardum",
  ];
  for (const subject of subjects) {
    await sendActionEmail({
      to: "recipient@example.com",
      subject,
      intro: "Hello <QA> & team",
      action: "Continue",
      url: "https://example.com/action?token=test&next=account",
    });
  }
  assert.equal(messages.length, subjects.length);
  for (const [index, raw] of messages.entries()) {
    const message = raw
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    assert.match(message, /From: Vardum <sender@example.com>/);
    assert.match(message, /To: recipient@example.com/);
    assert.ok(message.includes(`Subject: ${subjects[index]}\r\n`));
    assert.match(message, /Content-Type: multipart\/alternative;/);
    assert.match(message, /Content-Type: text\/plain;/);
    assert.match(message, /Content-Type: text\/html;/);
    assert.ok(message.includes(
      "Continue: https://example.com/action?token=test&next=account",
    ));
    assert.ok(message.includes("Hello &lt;QA&gt; &amp; team"));
    assert.ok(message.includes(
      'href="https://example.com/action?token=test&amp;next=account"',
    ));
  }
  assert.equal(
    envelopes.filter((line) => line === "MAIL FROM:<sender@example.com>").length,
    subjects.length,
  );
  assert.equal(
    envelopes.filter((line) => line === "RCPT TO:<recipient@example.com>").length,
    subjects.length,
  );
  assert.equal(authentications.length, subjects.length);
  assert.ok(authentications.every((value) => value === credentials));

  await assert.rejects(sendActionEmail({
    to: "rejected@example.com",
    subject: "Rejected recipient",
    intro: "Test SMTP failure",
    action: "Continue",
    url: "https://example.com/action",
  }), (error: unknown) => {
    assert.equal((error as { responseCode: number }).responseCode, 550);
    return true;
  });
  assert.equal(messages.length, subjects.length);
});
