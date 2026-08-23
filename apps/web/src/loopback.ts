/**
 * The callback is where a freshly minted CLI key is sent, so it decides who
 * ends up holding it. Only a loopback address can be one: anything else would
 * let a crafted link hand a working key to a stranger's server.
 */
export function loopbackCallback(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  return url.protocol === "http:" && loopback && url.port ? url : null;
}
