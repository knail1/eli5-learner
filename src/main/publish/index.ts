// Public API of the publish module (10).
export type {
  GitHandoffManifest,
  GitHandoffResult,
  GitInvocationMode,
  GitPublisherConfig,
  GitReadinessCheck,
  PrePublishDecision,
  PrePublishInput,
  PrePublishPolicy,
  PublicationRecord,
  PublishContext,
  PublishErrorCode,
  Publisher,
  PublisherKind,
  PublishFile,
  PublishLink,
  PublishProgressEvent,
  PublishResult,
  PublishStage,
  PublishTarget,
  SecretFinding,
  SecretScanner,
  SiteReadinessFn,
} from './types';
export { PublishError } from './types';
export { DrivePublisherStub } from './drive.stub';
export { GitPublisherStub } from './git.stub';
export { LocalPublisher, expandHome, abbreviateHome } from './local';
export { defaultPrePublishPolicy } from './policy';
export { BaselineSecretScanner, scanText, maskPreview, shannonEntropy } from './scanner';
export type { BaselineSecretScannerOptions } from './scanner';
export { registerPublic, registerPublicPublishers } from './register';

// M3 publish service (10 §4, §7): filled by the publishing slice.
export * from './service';
