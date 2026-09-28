/** Public AuthBroker stub against the AuthCapability contract suite (13 §10.2, 03 §12). */
import { PublicAuthBroker } from '../../src/main/sources';
import { describeAuthContract } from './auth.contract';

describeAuthContract('public broker', async () => new PublicAuthBroker('public'));
