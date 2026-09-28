// Dev-only tooling (not in packaged builds): a spending-capped provider wrapper and a headless
// real-run driver. The bootstrap reaches this only when !app.isPackaged and ELI5_REAL_RUN_* is set.
export { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, MODEL_RATES, costOf, ratesFor } from './rates';
export type { CostTokens, ModelRates } from './rates';
export { BudgetLedger } from './ledger';
export type { BudgetLedgerOptions, Charge, LedgerClock, Reservation } from './ledger';
export { BudgetGuardProvider, IMAGE_TOKENS, MIN_OUTPUT_TOKENS, estimateInputTokens } from './budget-guard';
export {
  DEFAULT_REAL_RUN_TIMEOUT_MS,
  MAX_REAL_RUN_BUDGET_USD,
  installBudgetGuard,
  prepareRealRun,
  realRunConfigFromEnv,
  startRealRun,
} from './real-run';
export type {
  GuardableRegistry,
  ProviderFactories,
  RealRunConfig,
  RealRunEnv,
  RealRunJobSummary,
  RealRunQueue,
  RealRunSession,
  RealRunSummary,
  StartRealRunOptions,
} from './real-run';
