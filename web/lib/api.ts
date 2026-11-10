/**
 * Resolves API URL for backend calls.
 * Works seamlessly whether running inside the Docker/Express server (port 8000),
 * Next.js dev server (port 3000 -> forwards to 8000), or custom NEXT_PUBLIC_API_URL.
 */
export function getApiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (process.env.NEXT_PUBLIC_API_URL) {
    const base = process.env.NEXT_PUBLIC_API_URL.replace(/\/+$/, "");
    return `${base}${cleanPath}`;
  }
  // When running Next.js dev server on port 3000, call the Express backend on port 8000
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `${window.location.protocol}//${window.location.hostname}:8000${cleanPath}`;
  }
  return cleanPath;
}

