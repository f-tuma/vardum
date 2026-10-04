// Runs in the application image. Only built-in Node modules; no fixture base image.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";

const kind = process.env.TLS_FIXTURE_KIND;
const credentials = {
  key: readFileSync(`/tls/${kind}.key`),
  cert: readFileSync(`/tls/${kind}.crt`),
};
const stats = { http: 0, mutations: 0, handshakes: 0, implicit: counters(), starttls: counters() };
function counters() { return { auth: 0, envelope: 0, data: 0, upgrades: 0, cleartextViolations: 0 }; }
const sockets = new Set();
function bound(socket) {
  if (sockets.size >= 32) return socket.destroy();
  sockets.add(socket);
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
}
const proxy = https.createServer(credentials, (request, response) => {
  stats.http++;
  if (!["GET", "HEAD"].includes(request.method)) stats.mutations++;
  // Preserve the signed Host header and path. Never retain authorization or bodies.
  const upstream = http.request({ host: "storage", port: 9000, method: request.method, path: request.url, headers: request.headers, timeout: 5_000 }, reply => {
    response.writeHead(reply.statusCode, reply.headers);
    let size = 0;
    reply.on("data", chunk => { if ((size += chunk.length) > 256 * 1024) reply.destroy(); });
    reply.pipe(response);
    reply.on("error", () => response.destroy());
  });
  let size = 0;
  request.on("data", chunk => { if ((size += chunk.length) > 256 * 1024) { request.destroy(); upstream.destroy(); } });
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", () => { response.destroy(); });
  request.pipe(upstream);
});
proxy.on("connection", bound);
proxy.on("secureConnection", () => stats.handshakes++);
proxy.on("tlsClientError", () => {});
proxy.requestTimeout = 10_000;
proxy.headersTimeout = 5_000;
proxy.listen(8443, "0.0.0.0");

function smtp(socket, encrypted, counts, greet = true) {
  let buffer = "", data = false, dataBytes = 0, authStep = 0;
  if (greet) socket.write("220 synthetic.invalid ESMTP runtime TLS fixture\r\n");
  const onData = chunk => {
    // DATA content and AUTH arguments are discarded, never written to logs/evidence.
    buffer += chunk.toString("ascii");
    if (buffer.length > 8192) return socket.destroy();
    let end;
    while ((end = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data) {
        dataBytes += line.length;
        if (dataBytes > 128 * 1024) return socket.destroy();
        if (line === ".") { data = false; socket.write("250 synthetic message discarded\r\n"); }
        continue;
      }
      if (authStep) { authStep--; socket.write(authStep ? "334 UGFzc3dvcmQ6\r\n" : "235 authenticated\r\n"); continue; }
      const command = line.split(" ", 1)[0].toUpperCase();
      if (!encrypted && ["AUTH", "MAIL", "RCPT", "DATA"].includes(command)) {
        counts.cleartextViolations++;
        socket.write("530 Must issue STARTTLS first\r\n");
      } else if (command === "EHLO" || command === "HELO") {
        socket.write(encrypted ? "250-synthetic.invalid\r\n250 AUTH PLAIN LOGIN\r\n" : "250-synthetic.invalid\r\n250 STARTTLS\r\n");
      } else if (command === "STARTTLS" && !encrypted) {
        counts.upgrades++;
        socket.removeListener("data", onData);
        if (buffer.length) return socket.destroy();
        socket.write("220 Ready to start TLS\r\n", () => {
          const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(credentials) });
          secure.on("error", () => {});
          secure.setTimeout(10_000, () => secure.destroy());
          smtp(secure, true, counts, false);
        });
        return;
      } else if (command === "AUTH") {
        counts.auth++;
        if (/^AUTH LOGIN$/i.test(line)) { authStep = 2; socket.write("334 VXNlcm5hbWU6\r\n"); }
        else socket.write("235 authenticated\r\n");
      } else if (["MAIL", "RCPT"].includes(command)) {
        counts.envelope++;
        socket.write("250 accepted\r\n");
      } else if (command === "DATA") {
        counts.data++;
        data = true;
        dataBytes = 0;
        socket.write("354 End data with dot\r\n");
      } else if (command === "QUIT") socket.end("221 goodbye\r\n");
      else if (command === "RSET" || command === "NOOP") socket.write("250 ok\r\n");
      else socket.write("500 unsupported command\r\n");
    }
  };
  socket.on("data", onData);
}
const implicit = tls.createServer(credentials, socket => smtp(socket, true, stats.implicit));
implicit.on("connection", bound);
implicit.on("tlsClientError", () => {});
implicit.listen(8465, "0.0.0.0");
const starttls = net.createServer(socket => { bound(socket); smtp(socket, false, stats.starttls); });
starttls.listen(8587, "0.0.0.0");
const metrics = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method !== "GET" || request.url !== "/metrics") { response.writeHead(404); return response.end(); }
  response.end(JSON.stringify({ ...stats, node: process.versions.node, openssl: process.versions.openssl }));
});
metrics.on("connection", bound);
metrics.listen(8081, "0.0.0.0");
function shutdown() {
  for (const server of [proxy, implicit, starttls, metrics]) server.close();
  for (const socket of sockets) socket.destroy();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
