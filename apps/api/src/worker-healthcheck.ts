try {
  const response = await fetch("http://127.0.0.1:3001/health", {
    signal: AbortSignal.timeout(3000),
  });
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
export {};
