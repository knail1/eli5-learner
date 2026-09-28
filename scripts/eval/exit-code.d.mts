export function exitCode(o: {
  calibrate: boolean;
  vitest: number;
  summary: { status?: string; regressed?: boolean; pass?: boolean } | undefined;
}): number;
