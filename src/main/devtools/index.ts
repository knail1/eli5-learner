// Dev-only tooling (not in packaged builds): a spending-capped provider wrapper and a headless
// real-run driver. The bootstrap reaches this only when !app.isPackaged and ELI5_REAL_RUN_* is set.
export { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, MODEL_RATES, costOf, ratesFor } from './rates';
export type { CostTokens, ModelRates } from './rates';
export { BudgetLedger } from './ledger';
export type { BudgetLedgerOptions, Charge, LedgerClock, Reservation } from './ledger';
export {
  BudgetGuardProvider,
  IMAGE_TOKENS,
  MIN_OUTPUT_TOKENS,
  estimateInputTokens,
  estimateTextTokens,
  maxAttempts,
} from './budget-guard';
export type { BudgetGuardOptions } from './budget-guard';
export {
  DEFAULT_DOC_GATE_USD,
  DEFAULT_REAL_RUN_TIMEOUT_MS,
  MAX_REAL_RUN_BUDGET_USD,
  MAX_REBUILD_DOCS,
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
  RebuildRunConfig,
  StartRealRunOptions,
} from './real-run';
export {
  REBUILD_HARD_STOP_USD,
  TYPICAL_OUTPUT_TOKENS,
  TYPICAL_RETRY_SHARE,
  planRebuildCost,
  rebuildPlanInputs,
  startRebuildRun,
  verifyRebuild,
} from './rebuild';
export type {
  CostPlan,
  CostPlanInput,
  PlannedCall,
  RebuildDocRow,
  RebuildLibrary,
  RebuildPlanInputs,
  RebuildPlanRow,
  RebuildPlanStep,
  RebuildPreflight,
  RebuildPromptId,
  RebuildQueue,
  RebuildRunSummary,
  RebuildVerify,
  StartRebuildRunOptions,
  VerifyExpect,
} from './rebuild';
