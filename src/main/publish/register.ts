import type { CapabilityRegistry } from '../editions';
import { DrivePublisherStub } from './drive.stub';
import { GitPublisherStub } from './git.stub';
import { LocalPublisher } from './local';
import { defaultPrePublishPolicy } from './policy';
import { BaselineSecretScanner } from './scanner';

/** Public-build publish capabilities (10 §4; 01 §6.3 hook table rows HOOK-PUB-01/03/05). */
export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerPublisher('local', () => new LocalPublisher());
  reg.registerPublisher('drive', () => new DrivePublisherStub()); // HOOK-PUB-01
  reg.registerPublisher('git', () => new GitPublisherStub()); // HOOK-PUB-03
  reg.registerSecretScanner(new BaselineSecretScanner()); // HOOK-PUB-03
  reg.registerPrePublishPolicy(defaultPrePublishPolicy); // HOOK-PUB-05
}

/** Spec name (10 §4). */
export const registerPublicPublishers = registerPublic;
