import { AccountBar } from './AccountBar';
import { CredentialBar } from './CredentialBar';

/**
 * Shared holder at the top right of the title strip (02 §14, 10 §5.4). Absolutely positioned and
 * excluded from window dragging, so no other layout moves; empty when no provider or publisher
 * opts in.
 */
export function TopStatus() {
  return (
    <div className="top-status">
      <CredentialBar />
      <AccountBar />
    </div>
  );
}

export { AccountBar, CredentialBar };
