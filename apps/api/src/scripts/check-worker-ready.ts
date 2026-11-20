const port = process.env.WORKER_HEALTH_PORT;

try {
  if (port) {
    const response = await fetch(`http://127.0.0.1:${port}/ready`, {
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
    if (response.status === 204) process.exit(0);
  }
} catch {
  // The health check reports no connection details.
}

console.error("The notification worker is not ready.");
process.exitCode = 1;

export {};
