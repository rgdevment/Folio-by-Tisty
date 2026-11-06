// The form a revocation is written in, so moments sort as they read (decision 134).
export const momentOf = (milliseconds: number): string => new Date(milliseconds).toISOString().replace(/\.\d+Z$/, "Z");
