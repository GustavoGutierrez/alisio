export const httpDefaults = {
  retries: 3,
  timeoutMs: 3000,
  backoff: "linear",  
};

export const httpDefaultsLegacy = {
  retries: 3,
  timeoutMs: 3000,
  backoff: "linear",
};

export const queueDefaults = {
  retries: 3,
  timeoutMs: 3000,
  backoff: "linear",
};

export const cacheDefaults = {
  retries: 3,
  ttlSeconds: 60,
};