import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";

export type Grant = { state: string; key: string; workspace: string };

const loginTimeoutMs = 5 * 60 * 1000;

/**
 * Reads the grant the browser posts back. Returns null for anything that is not
 * this login: a stale tab, or another process on the machine guessing the port.
 */
export function readGrant(body: string, expectedState: string): Grant | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { state, key, workspace } = parsed as Record<string, unknown>;
  if (typeof state !== "string" || state !== expectedState) return null;
  if (typeof key !== "string" || !key) return null;
  if (typeof workspace !== "string" || !workspace) return null;
  return { state, key, workspace };
}

/**
 * Listens on a throwaway loopback port for the one POST the authorize page
 * makes, and hands back the key it carries.
 */
export function awaitGrant(state: string) {
  const server = createServer();
  const grant = new Promise<Grant>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the browser"));
    }, loginTimeoutMs);
    timer.unref();

    server.on("error", reject);
    server.on("request", (request, response) => {
      // The page is served from the Vardum origin, so it needs permission to
      // talk to this listener at all.
      response.setHeader("access-control-allow-origin", "*");
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        // Nothing legitimate is large; stop reading rather than buffer forever.
        if (chunks.reduce((sum, part) => sum + part.length, 0) > 8192)
          request.destroy();
      });
      request.on("end", () => {
        const received = readGrant(
          Buffer.concat(chunks).toString("utf8"),
          state,
        );
        if (!received) {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(204).end();
        clearTimeout(timer);
        server.close();
        resolve(received);
      });
    });
  });

  const listening = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
      else reject(new Error("Could not open a local port"));
    });
  });

  return { grant, listening, close: () => server.close() };
}

export function loginUrl(
  server: string,
  port: number,
  state: string,
  label: string,
) {
  const url = new URL("/cli-login", server);
  url.searchParams.set("callback", `http://127.0.0.1:${port}/`);
  url.searchParams.set("state", state);
  url.searchParams.set("label", label);
  return url.toString();
}

export function newState() {
  return randomUUID();
}

/** Best effort: the URL is printed too, so a headless machine still works. */
export function openBrowser(url: string) {
  const command =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: platform() === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printing the URL is the fallback, and the caller has already done it.
  }
}
