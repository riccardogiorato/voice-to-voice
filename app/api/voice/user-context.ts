export type UserContext = {
  timeZone?: string;
  city?: string;
  country?: string;
  countryRegion?: string;
};

export function userContextFromRequest(request: Request): UserContext {
  return compactContext({
    timeZone: validTimeZone(request.headers.get("x-vercel-ip-timezone")),
    city: decodedHeader(request.headers.get("x-vercel-ip-city")),
    country: cleanHeader(request.headers.get("x-vercel-ip-country")),
    countryRegion: cleanHeader(
      request.headers.get("x-vercel-ip-country-region"),
    ),
  });
}

export function validTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timeZone = value.trim().slice(0, 100);
  if (!timeZone) return undefined;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return undefined;
  }
}

function decodedHeader(value: string | null) {
  const cleaned = cleanHeader(value);
  if (!cleaned) return undefined;

  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

function cleanHeader(value: string | null) {
  const cleaned = value?.trim().slice(0, 100);
  return cleaned || undefined;
}

function compactContext(context: UserContext): UserContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as UserContext;
}
