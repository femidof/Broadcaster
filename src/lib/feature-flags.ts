const truthy = (value: unknown): boolean => {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

export const featureFlags = {
  reliabilitySuite: truthy(import.meta.env.VITE_FEATURE_RELIABILITY_SUITE),
  analytics: truthy(import.meta.env.VITE_FEATURE_ANALYTICS),
} as const;

