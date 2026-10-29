import type { Accessory } from '../components/Avatar';
import { useSession } from './session';
import { useData } from './hooks';

/** Best first: what "auto" puts on Carino. */
const AUTO_ORDER: Accessory[] = ['crown', 'chef', 'cap', 'headband'];

/** Which accessory Carino wears, and which ones the user has earned through challenges. */
export function useMascot() {
  const { me } = useSession();
  const a = useData<any>('/achievements', { cache: true });
  const profile = me!.settings.profile;
  const owned = new Set<string>(a.data?.accessories ?? ['none', 'party']);
  const earned = (acc: Accessory) => acc === 'none' || owned.has(acc);
  const choice = (profile.mascotAccessory ?? 'auto') as Accessory | 'auto';
  const accessory: Accessory = choice !== 'auto' ? (earned(choice) ? choice : 'none') : AUTO_ORDER.find((x) => owned.has(x)) ?? 'none';
  return { accessory, achievements: a.data, earned, name: profile.assistantName || 'Carino' };
}
